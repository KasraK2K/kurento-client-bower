require=(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var EventEmitter = require('events').EventEmitter;
var url = require('url');

var async = require('async');
var extend = require('extend');
var inherits = require('inherits');
var reconnect = require('reconnect-ws');

var checkType = require('./checkType');

var RpcBuilder = require('kurento-jsonrpc');
var JsonRPC = RpcBuilder.packers.JsonRPC;

var promiseCallback = require('promisecallback');

var disguise = require('./disguise')
var createPromise = require('./createPromise');
var MediaObjectCreator = require('./MediaObjectCreator');
var TransactionsManager = require('./TransactionsManager');

var TransactionNotCommitedException = TransactionsManager
  .TransactionNotCommitedException;
var transactionOperation = TransactionsManager.transactionOperation;

var MediaObject = require('kurento-client-core').abstracts.MediaObject;

const MEDIA_OBJECT_TYPE_NOT_FOUND = 40100
const MEDIA_OBJECT_NOT_FOUND = 40101
const MEDIA_OBJECT_METHOD_NOT_FOUND = 40105
const INVALID_SESSION = 40007

const BASE_TIMEOUT = 20000;

var PING_INTERVAL = 5000;
var HEARTBEAT = 60000;
var pingNextNum = 0;
var enabledPings = true;
var pingPongStarted = false;
var pingInterval;
var notReconnectIfNumLessThan = -1;

/**
 * @function module:kurentoClient.KurentoClient~findIndex
 *
 * @param {external:Array} list
 * @param {external:Function} predicate
 *
 * @return {external:Integer}
 */
function findIndex(list, predicate) {
  for (var i = 0, item; item = list[i]; i++)
    if (predicate(item)) return i;

  return -1;
};

/**
 * Serialize objects using their id
 *
 * @function module:kurentoClient.KurentoClient~serializeParams
 *
 * @param {external:Object} params
 *
 * @return {external:Object}
 */
function serializeParams(params) {
  for (var key in params) {
    var param = params[key];
    if (param instanceof MediaObject || (param && (params.object !==
        undefined ||
        params.hub !== undefined || params.sink !== undefined))) {
      if (param && param.id != null) {
        params[key] = param.id;
      }
    }
  };

  return params;
};

/**
 * @function module:kurentoClient.KurentoClient~serializeOperation
 *
 * @param {external:Object} operation
 * @param {external:Integer} index
 */
function serializeOperation(operation, index) {
  var params = operation.params;

  switch (operation.method) {
  case 'create':
    params.constructorParams = serializeParams(params.constructorParams);
    break;

  default:
    params = serializeParams(params);
    params.operationParams = serializeParams(params.operationParams);
  };

  operation.jsonrpc = "2.0";

  operation.id = index;
};

/**
 * @function module:kurentoClient.KurentoClient~deferred
 *
 * @param {module:core/abstracts.MediaObject} mediaObject
 * @param {external:Object} params
 * @param {external:Promise} prevRpc
 * @param {external:Function} callback
 *
 * @return {external:Promise}
 */
function deferred(mediaObject, params, prevRpc, callback) {
  var promises = [];

  if (mediaObject != undefined)
    promises.push(mediaObject);

  for (var key in params) {
    var param = params[key];
    if (param !== undefined)
      promises.push(param);
  };

  if (prevRpc != undefined)
    promises.push(prevRpc);

  return promiseCallback(Promise.all(promises), callback);
};

/**
 * @function module:kurentoClient.KurentoClient~noop
 *
 * @param error
 * @param result
 *
 * @return result
 */
function noop(error, result) {
  if (error) console.trace(error);

  return result
};

/**
 * @typedef {Object} module:kurentoClient.KurentoClient~KurentoClientDict
 *   @property {external:Number} [failAfter=Infinity]
 *    Fail after N reconnection attempts
 *   @property {external:Boolean} [enableTransactions=true]
 *    Enable transactions functionality
 *   @property {external:Boolean} [strict=true]
 *    Throw an error when creating an object of unknown type
 *   @property {external:String} [access_token]
 *    Set access token for the WebSocket connection
 *   @property {external:Number} [max_retries=0]
 *    Number of tries to send the requests
 *   @property {external:Number} [request_timeout=20000]
 *    Timeout between requests retries
 *   @property {external:Number} [response_timeout=20000]
 *    Timeout while a response is being stored
 *   @property {external:Number} [duplicates_timeout=20000]
 *    Timeout to ignore duplicated responses
 *   @property {Object} [socket]
 *    Websocket connection options
 */

/**
 * Creates a connection with the Kurento Media Server
 *
 * @class module:kurentoClient.KurentoClient
 *
 * @param {external:String} ws_uri - Address of the Kurento Media Server
 * @param {module:kurentoClient.KurentoClient~KurentoClientDict} [options]
 * @param {module:kurentoClient.KurentoClient~constructorCallback} [callback]
 */
function KurentoClient(ws_uri, options, callback) {
  if (!(this instanceof KurentoClient))
    return new KurentoClient(ws_uri, options, callback);

  var self = this;

  EventEmitter.call(this);

  // Promises to check previous RPC calls
  var prevRpc = Promise.resolve(); // request has been send
  var prevRpc_result = Promise.resolve(); // response has been received

  // Fix optional parameters
  if (options instanceof Function) {
    callback = options;
    options = undefined;
  };

  options = options || {};

  var failAfter = options.failAfter
  if (failAfter == undefined) failAfter = Infinity

  if (options.enableTransactions === undefined) options.enableTransactions =
    true
  if (options.strict === undefined) options.strict = true

  options.request_timeout = options.request_timeout || BASE_TIMEOUT;
  options.response_timeout = options.response_timeout || BASE_TIMEOUT;
  options.duplicates_timeout = options.duplicates_timeout || BASE_TIMEOUT;

  var objects = {};

  function onNotification(message) {
    var method = message.method;
    var params = message.params.value;

    var id = params.object;

    var object = objects[id];
    if (!object)
      return console.warn("Unknown object id '" + id + "'", message);

    switch (method) {
    case 'onEvent':
      object.emit(params.type, params.data);
      break;

      //      case 'onError':
      //        object.emit('error', params.error);
      //      break;

    default:
      console.warn("Unknown message type '" + method + "'");
    };
  };

  //
  // JsonRPC
  //

  if (typeof ws_uri == 'string') {
    var access_token = options.access_token;
    if (access_token != undefined) {
      ws_uri = url.parse(ws_uri, true);
      ws_uri.query.access_token = access_token;
      ws_uri = url.format(ws_uri);

      delete options.access_token;
    };
  }

  var rpc = new RpcBuilder(JsonRPC, options, function (request) {
    if (request instanceof RpcBuilder.RpcNotification) {
      // Message is an unexpected request, notify error
      if (request.duplicated != undefined)
        return console.warn('Unexpected request:', request);

      // Message is a notification, process it
      return onNotification(request);
    };

    // Invalid message, notify error
    console.error('Invalid request instance', request);
  });

  // Select what transactions mechanism to use
  var encodeTransaction = options.enableTransactions ? commitTransactional :
    commitSerial;

  // Transactional API

  var transactionsManager = new TransactionsManager(this,
    function (operations, callback) {
      var params = {
        object: self,
        operations: operations
      };

      encodeTransaction(params, callback)
    });

  this.beginTransaction = transactionsManager.beginTransaction.bind(
    transactionsManager);
  this.endTransaction = transactionsManager.endTransaction.bind(
    transactionsManager);
  this.transaction = transactionsManager.transaction.bind(transactionsManager);

  Object.defineProperty(this, 'sessionId', {
    configurable: true
  })
  this.on('disconnect', function () {
    onDisconnected();
    Object.defineProperty(this, 'sessionId', {
      configurable: false,
      get: function () {
        throw new SyntaxError('Client has been disconnected')
      }
    })

    for (var id in objects)
      objects[id].emit('release')
  })

  // Emit events

  function onReconnected(sameSession) {
    self.emit('reconnected', sameSession);
  }

  function onDisconnected() {
    self.emit('disconnected');
  }

  function onConnectionFailed() {
    self.emit('connectionFailed');
  }

  function onConnected() {
    self.emit('connected');
  }

  // Encode commands

  function send(request) {
    var method = request.method
    var params = request.params
    var callback = request.callback
    var stack = request.stack

    var requestTimestamp = Date.now()

    rpc.encode(method, params, function (error, result) {
      if (error) {
        var responseTimestamp = Date.now()

        var constructor = Error
        switch (error.code) {
        case MEDIA_OBJECT_TYPE_NOT_FOUND:
          constructor = TypeError
          break

        case MEDIA_OBJECT_NOT_FOUND:
          constructor = ReferenceError
          break

        case MEDIA_OBJECT_METHOD_NOT_FOUND:
          constructor = SyntaxError
          break
        }

        error = extend(new constructor(error.message || error), error);

        Object.defineProperties(error, {
          'requestTimestamp': {
            value: requestTimestamp
          },
          'responseTimestamp': {
            value: responseTimestamp
          },
          'stack': {
            value: [error.toString()].concat(
              error.stack.split('\n')[1],
              error.stack.split('\n').slice(2)
            ).join('\n')
          }
        })
      } else if ((self.sessionId !== result.sessionId) && (result.value !==
          'pong'))
        Object.defineProperty(self, 'sessionId', {
          configurable: true,
          value: result.sessionId
        })

      callback(error, result);
    });
  }

  function operationResponse(operation, index) {
    var callback = operation.callback || noop;

    var operation_response = this.value[index];
    if (operation_response == undefined)
      return callback(new Error(
        'Command not executed in the server'));

    var error = operation_response.error;
    var result = operation_response.result;

    var id;
    if (result) id = result.value;

    switch (operation.method) {
    case 'create':
      var mediaObject = operation.params.object;

      if (error) {
        mediaObject.emit('_id', error);
        return callback(error)
      }

      callback(null, registerObject(mediaObject, id));
      break;

    default:
      callback(error, result);
    }
  }

  function sendImplicitTransaction(operations) {
    function callback(error, result) {
      if (error) return console.error('Implicit transaction failed')

      operations.forEach(operationResponse, result)
    }

    operations.forEach(serializeOperation)

    var request = {
      method: 'transaction',
      params: {
        operations: operations
      },
      callback: callback
    }
    send(request)
  }

  var queueEncode = []

  function sendQueueEncode() {
    var request = queueEncode.shift()

    // We have several pending requests, create an "implicit" transaction
    if (queueEncode.length) {
      // Send (implicit) transactions from previous iteration
      while (request && request.method === 'transaction') {
        send(request)
        request = queueEncode.shift()
      }

      // Encode and queue transactions from current iteration to exec on next one
      var operations = []

      while (request) {
        if (request.method === 'transaction') {
          if (operations.length) {
            sendImplicitTransaction(operations)
            operations = []
          }

          send(request)
        } else
          operations.push(request)

        request = queueEncode.shift()
      }

      // Encode and queue remaining operations for next iteration
      if (operations.length) sendImplicitTransaction(operations)
    }

    // We have only one pending request, send it directly
    else
      send(request)
  }

  function encode(method, params, callback) {
    var stack = (new Error).stack

    params.sessionId = self.sessionId

    self.then(function () {
        if (options.useImplicitTransactions && !queueEncode.length)
          async.setImmediate(sendQueueEncode)

        var request = {
          method: method,
          params: params,
          callback: callback
        }
        Object.defineProperty(request, 'stack', {
          value: stack
        })

        if (options.useImplicitTransactions)
          queueEncode.push(request)
        else
          send(request)
      },
      callback)
  }

  function encodeCreate(transaction, params, callback) {
    if (transaction)
      return transactionOperation.call(transaction, 'create', params, callback)

    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'create',
        params, callback);

    callback = callback || noop;

    function callback2(error, result) {
      var mediaObject = params.object;

      // Implicit transaction has already register the MediaObject
      if (mediaObject === result) return callback(null, mediaObject);

      if (error) {
        mediaObject.emit('_id', error);
        return callback(error);
      }

      var id = result.value;

      callback(null, registerObject(mediaObject, id));
    }

    return deferred(null, params.constructorParams, null, function (error) {
        if (error) throw error;

        params.constructorParams = serializeParams(params.constructorParams);

        return encode('create', params, callback2);
      })
      .catch(callback)
  };

  /**
   * Request a generic functionality to be procesed by the server
   */
  function encodeRpc(transaction, method, params, callback) {
    if (transaction)
      return transactionOperation.call(transaction, method, params,
        callback);

    var object = params.object;
    if (object && object.transactions && object.transactions.length) {
      var error = new TransactionNotCommitedException();
      error.method = method;
      error.params = params;

      return setTimeout(callback, 0, error)
    };

    for (var key in params.operationParams) {
      var object = params.operationParams[key];

      if (object && object.transactions && object.transactions.length) {
        var error = new TransactionNotCommitedException();
        error.method = method;
        error.params = params;

        return setTimeout(callback, 0, error)
      };
    }

    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, method, params,
        callback);

    var promise = new Promise(function (resolve, reject) {
      function callback2(error, result) {
        if (error) return reject(error);

        resolve(result);
      };

      prevRpc = deferred(params.object, params.operationParams, prevRpc,
          function (error) {
            if (error) throw error

            params = serializeParams(params);
            params.operationParams = serializeParams(params
              .operationParams);

            return encode(method, params, callback2);
          })
        .catch(reject)
    });

    prevRpc_result = promiseCallback(promise, callback);

    if (method == 'release') prevRpc = prevRpc_result;
  }

  // Commit mechanisms

  /**
   * @function module:kurentoClient.KurentoClient~commitTransactional
   *
   * @param {external:Object} params
   * @param {external:Function} callback
   */
  function commitTransactional(params, callback) {
    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'transaction',
        params, callback);

    callback = callback || noop;

    var operations = params.operations;

    var promises = [];

    function checkId(operation, param) {
      if (param instanceof MediaObject && param.id === undefined) {
        var index = findIndex(operations, function (element) {
          return operation != element && element.params.object === param;
        });

        // MediaObject dependency is created in this transaction,
        // set a new reference ID
        if (index >= 0)
          return 'newref:' + index;

        // MediaObject dependency is created outside this transaction,
        // wait until it's ready
        promises.push(param);
      }

      return param
    }

    // Fix references to uninitialized MediaObjects
    operations.forEach(function (operation) {
      var params = operation.params;

      switch (operation.method) {
      case 'create':
        var constructorParams = params.constructorParams;
        for (var key in constructorParams)
          constructorParams[key] = checkId(operation, constructorParams[
            key]);
        break;

      default:
        params.object = checkId(operation, params.object);

        var operationParams = params.operationParams;
        for (var key in operationParams)
          operationParams[key] = checkId(operation, operationParams[key]);
      };
    });

    function callback2(error, result) {
      if (error) return callback(error);

      operations.forEach(operationResponse, result)

      callback(null, result);
    };

    Promise.all(promises).then(function () {
        operations.forEach(serializeOperation)

        encode('transaction', params, callback2);
      },
      callback);
  }

  /**
   * @function module:kurentoClient.KurentoClient~commitSerial
   *
   * @param {external:Object} params
   * @param {external:Function} callback
   */
  function commitSerial(params, callback) {
    if (transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'transaction',
        params, callback);

    var operations = params.operations;

    async.each(operations, function (operation) {
        switch (operation.method) {
        case 'create':
          encodeCreate(undefined, operation.params, operation.callback);
          break;

        case 'transaction':
          commitSerial(operation.params.operations, operation.callback);
          break;

        default:
          encodeRpc(undefined, operation.method, operation.params,
            operation.callback);
        }
      },
      callback)
  }

  /**
   * @function module:kurentoClient.KurentoClient~registerObject
   *
   * @param {module:core/abstracts.MediaObject} mediaObject
   * @param {external:string} id
   */
  function registerObject(mediaObject, id) {
    var object = objects[id];
    if (object) return object;

    mediaObject.emit('_id', null, id);

    objects[id] = mediaObject;

    /**
     * Remove the object from cache
     */
    mediaObject.once('release', function () {
      delete objects[id];
    });

    return mediaObject;
  }

  // Creation of objects

  /**
   * Get a MediaObject from its ID
   *
   * @function module:kurentoClient.KurentoClient#getMediaobjectById
   *
   * @param {(external:String|external:string[])} id - ID of the MediaElement
   * @param {module:kurentoClient.KurentoClient~getMediaobjectByIdCallback} callback
   *
   * @return {external:Promise}
   */
  this.getMediaobjectById = function (id, callback) {
    return disguise(createPromise(id, describe, callback), this)
  };
  /**
   * @callback module:kurentoClient.KurentoClient~getMediaobjectByIdCallback
   * @param {external:Error} error
   * @param {(module:core/abstracts.MediaElement|module:core/abstracts.MediaElement[])} result
   *  The requested MediaElement
   */

  var mediaObjectCreator = new MediaObjectCreator(this, encodeCreate,
    encodeRpc, encodeTransaction, this.getMediaobjectById.bind(this),
    options.strict);

  /**
   * @function module:kurentoClient.KurentoClient~describe
   *
   * @param {external:string} id
   * @param {external:Function} callback
   */
  function describe(id, callback) {
    if (id == undefined)
      return callback(new TypeError("'id' can't be null or undefined"))

    var mediaObject = objects[id];
    if (mediaObject) return callback(null, mediaObject);

    var params = {
      object: id
    };

    function callback2(error, result) {
      if (error) return callback(error);

      var mediaObject = mediaObjectCreator.createInmediate(result);

      return callback(null, registerObject(mediaObject, id));
    }

    encode('describe', params, callback2);
  };

  /**
   * @function module:kurentoClient.KurentoClient#_resetCache
   * @private
   */
  Object.defineProperty(this, '_resetCache', {
    value: function () {
      objects = {}
    }
  })

  /**
   * Create a new instance of a MediaObject
   *
   * @function module:kurentoClient.KurentoClient#create
   *
   * @param {external:String} type - Type of the element
   * @param {external:string[]} [params]
   * @param {module:kurentoClient.KurentoClient~createCallback} callback
   *
   * @return {(module:core/abstracts.MediaObject|module:core/abstracts.MediaObject[])}
   */
  this.create = mediaObjectCreator.create.bind(mediaObjectCreator);
  /**
   * @callback module:kurentoClient.KurentoClient~createCallback
   * @param {external:Error} error
   * @param {module:core/abstracts.MediaElement} result
   *  The created MediaElement
   */

  function connect(callback) {
    callback = (callback || noop).bind(this)

    //
    // Ping
    //
    function enablePing() {
      enabledPings = true;
      if (!pingPongStarted) {
        pingPongStarted = true;
        pingInterval = setInterval(sendPing, HEARTBEAT);
        sendPing();
      }
    }

    function updateNotReconnectIfLessThan() {
      notReconnectIfNumLessThan = pingNextNum;
      console.log("notReconnectIfNumLessThan = " + notReconnectIfNumLessThan);
    }

    function sendPing() {
      if (enabledPings) {
        var params = null;

        if (pingNextNum == 0 || pingNextNum == notReconnectIfNumLessThan) {
          params = {
            interval: PING_INTERVAL
          };
        }

        pingNextNum++;

        var request = {
          method: 'ping',
          params: params,
          callback: (function (pingNum) {
            return function (error, result) {
              if (error) {
                if (pingNum > notReconnectIfNumLessThan) {
                  enabledPings = false;
                  updateNotReconnectIfLessThan();
                  console.log(
                    "Server did not respond to ping message " +
                    pingNum + ".");
                  clearInterval(pingInterval);
                  pingPongStarted = false;
                }
              }
            }
          }(pingNextNum))
        }
        send(request);
      } else {
        console.log("Trying to send ping, but ping is not enabled");
      }
    }

    //
    // Reconnect websockets
    //

    var closed = false;
    var reconnected = false;
    var re = reconnect({
        // all options are optional
        // initialDelay: 1e3,
        // maxDelay: 30e3,
        // type: 'fibonacci',      // available: fibonacci, exponential
        // randomisationFactor: 0,
        // immediate: false
        failAfter: failAfter
      }, function (ws_stream) {
        if (closed)
          ws_stream.writable = false;

        rpc.transport = ws_stream;
        enablePing();
        if (reconnected) {
          var params = {
            sessionId: self.sessionId
          };
          var request = {
            method: 'connect',
            params: params,
            callback: function (error, response) {
              if (error) {
                if (error.code === INVALID_SESSION) {
                  console.log("Invalid Session")
                  objects = {}
                  onReconnected(false);
                }
              } else {
                onReconnected(true);
              }
            }
          }
          send(request);
        } else {
          onConnected();
        }
      })
      .connect(ws_uri, options.socket);

    Object.defineProperty(this, '_re', {
      get: function () {
        return re
      }
    })

    /**
     * @function module:kurentoClient.KurentoClient#close
     */
    this.close = function () {
      closed = true;

      prevRpc_result.then(re.disconnect.bind(re));
    };

    re.on('fail', this.emit.bind(this, 'disconnect'));

    re.on('reconnect', function (n, delay) {
      console.log('reconnect to server', n, delay, self.sessionId);
      if (pingInterval != undefined) {
        clearInterval(pingInterval);
        pingPongStarted = false;
      }

      reconnected = true;
    })

    //
    // Promise interface ("thenable")
    //

    /**
     * @function module:kurentoClient.KurentoClient#then
     *
     * @param {external:Function} onFulfilled
     * @param {external:Function} [onRejected]
     *
     * @return {external:Promise}
     */
    this.then = function (onFulfilled, onRejected) {
      if (re.connected)
        var promise = Promise.resolve(disguise.unthenable(this))
      else if (!re.reconnect)
        var promise = Promise.reject(new Error('Connection error'))
      else {
        var self = this

        var promise = new Promise(function (resolve, reject) {
          function success() {
            re.removeListener('fail', failure);

            resolve(disguise.unthenable(self));
          };

          function failure() {
            re.removeListener('connection', success);

            reject(new Error('Connection error'));
          };

          re.once('connection', success);
          re.once('fail', failure);
        });

      }

      promise = promise.then(onFulfilled ? onFulfilled.bind(this) :
        function (result) {
          return Promise.resolve(result)
        },
        onRejected ? onRejected.bind(this) :
        function (error) {
          return Promise.reject(error)
        });

      return disguise(promise, this)
    };

    /**
     * @function module:kurentoClient.KurentoClient#catch
     *
     * @param {external:Function} [onRejected]
     *
     * @return {external:Promise}
     */
    this.catch = this.then.bind(this, null);

    // Check for available modules in the Kurento Media Server

    var thenable = this
    if (options.strict)
      thenable = this.getServerManager()
      .then(function (serverManager) {
        return serverManager.getInfo()
      })
      .then(function (info) {
        var serverModules = info.modules.map(function (module) {
          return module.name
        })

        var notInstalled = KurentoClient.register.modules.filter(
          function (module) {
            return serverModules.indexOf(module) < 0
          })

        var length = notInstalled.length
        if (length) {
          if (length === 1)
            var message = "Module '" + notInstalled[0] +
              "' is not installed in the Kurento Media Server"
          else
            var message = "Modules '" + notInstalled.slice(0, -1).join(
                "', '") +
              "' and '" + notInstalled[length - 1] +
              "' are not installed in the Kurento Media Server"

          var error = new SyntaxError(message)
          error.modules = notInstalled

          return Promise.reject(error)
        }

        return Promise.resolve(self)
      })

    promiseCallback(thenable, callback);
  };
  connect.call(self, callback);
};
inherits(KurentoClient, EventEmitter);
/**
 * @callback module:kurentoClient.KurentoClient~constructorCallback
 * @param {external:Error} error
 * @param {module:kurentoClient.KurentoClient} client
 *  The created KurentoClient
 */

/**
 * Connect the source of a media to the sink of the next one
 *
 * @function module:kurentoClient.KurentoClient#connect
 *
 * @param {...module:core/abstracts.MediaObject} media - A media to be connected
 * @param {module:kurentoClient.KurentoClient~connectCallback} [callback]
 *
 * @return {external:Promise}
 *
 * @throws {SyntaxError}
 */
KurentoClient.prototype.connect = function (media, callback) {
  if (!(media instanceof Array)) {
    media = Array.prototype.slice.call(arguments, 0);
    callback = (typeof media[media.length - 1] === 'function') ? media.pop() :
      undefined;
  }

  callback = (callback || noop).bind(this)

  // Check if we have enought media components
  if (media.length < 2)
    throw new SyntaxError("Need at least two media elements to connect");

  return media[0].connect(media.slice(1), callback)
};
/**
 * @callback module:kurentoClient.KurentoClient~connectCallback
 * @param {external:Error} error
 */

/**
 * Get a reference to the current Kurento Media Server we are connected
 *
 * @function module:kurentoClient.KurentoClient#getServerManager
 *
 * @param {module:kurentoClient.KurentoClient~getServerManagerCallback} callback
 *
 * @return {external:Promise}
 */
KurentoClient.prototype.getServerManager = function (callback) {
  return this.getMediaobjectById('manager_ServerManager', callback)
};
/**
 * @callback module:kurentoClient.KurentoClient~getServerManagerCallback
 * @param {external:Error} error
 * @param {module:core/abstracts.ServerManager} server
 *  Info of the MediaServer instance
 */

//
// Helper function to return a singleton client for a particular ws_uri
//
var singletons = {};

/**
 * Creates a unique connection with the Kurento Media Server
 *
 * @function module:kurentoClient.KurentoClient.getSingleton
 * @see module:kurentoClient.KurentoClient
 *
 * @param {external:String} ws_uri - Address of the Kurento Media Server
 * @param {module:kurentoClient.KurentoClient~KurentoClientDict} [options]
 * @param {module:kurentoClient.KurentoClient~constructorCallback} [callback]
 *
 * @return {external:Promise}
 */
KurentoClient.getSingleton = function (ws_uri, options, callback) {
  var client = singletons[ws_uri]
  if (!client) {
    // Fix optional parameters
    if (options instanceof Function) {
      callback = options;
      options = undefined;
    };

    client = KurentoClient(ws_uri, options, function (error, client) {
      if (error) return callback(error);

      singletons[ws_uri] = client
      client.on('disconnect', function () {
        delete singletons[ws_uri]
      })
    });
  }

  return disguise(promiseCallback(client, callback), client)
}

/**
 * Get a complexType across the qualified name
 *
 * @function module:kurentoClient.KurentoClient#getComplexType
 *
 * @param {external:String} complexType - ComplexType's name
 *
 * @return {module:core/complexType}
 */
KurentoClient.getComplexType = function (complexType) {
  return KurentoClient.register.complexTypes[complexType]
};

// Export KurentoClient

module.exports = KurentoClient;

},{"./MediaObjectCreator":2,"./TransactionsManager":3,"./checkType":5,"./createPromise":6,"./disguise":7,"async":"async","events":21,"extend":22,"inherits":"inherits","kurento-client-core":"kurento-client-core","kurento-jsonrpc":117,"promisecallback":"promisecallback","reconnect-ws":143,"url":147}],2:[function(require,module,exports){
/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var async = require('async');

var checkType = require('./checkType');
var checkParams = checkType.checkParams;
var extend = require('extend');

var createPromise = require('./createPromise');
var register = require('./register');

var Transaction = require('./TransactionsManager').Transaction;

/**
 * Get the constructor for a type
 *
 * If the type is not registered, use generic {module:core/abstracts.MediaObject}
 *
 * @function module:kurentoClient~MediaObjectCreator~getConstructor
 *
 * @param {external:string} type
 * @param {external:Boolean} strict
 *
 * @return {module:core/abstracts.MediaObject}
 */
function getConstructor(type, strict) {
  var result = register.classes[type.qualifiedType] || register.abstracts[type
      .qualifiedType] ||
    register.classes[type.type] || register.abstracts[type.type] ||
    register.classes[type] || register.abstracts[type];
  if (result) return result;

  if (type.hierarchy != undefined) {
    for (var i = 0; i <= type.hierarchy.length - 1; i++) {
      var result = register.classes[type.hierarchy[i]] || register.abstracts[
        type.hierarchy[i]];
      if (result) return result;
    };
  }
  if (strict) {
    var error = new SyntaxError("Unknown type '" + type + "'")
    error.type = type

    throw error
  }

  console.warn("Unknown type '", type, "', using MediaObject instead");
  return register.abstracts.MediaObject;
};

/**
 * @function module:kurentoClient~MediaObjectCreator~createConstructor
 *
 * @param item
 * @param {external:Boolean} strict
 *
 * @return {module:core/abstracts.MediaObject}
 */
function createConstructor(item, strict) {
  var constructor = getConstructor(item, strict);

  if (constructor.create) {
    item = constructor.create(item.params);

    // Apply inheritance
    var prototype = constructor.prototype;
    inherits(constructor, getConstructor(item, strict));
    extend(constructor.prototype, prototype);
  };

  constructor.item = item;

  return constructor;
}

var checkMediaElement = checkType.bind(null, 'MediaElement', 'media');

/**
 * @class module:kurentoClient~MediaObjectCreator
 *
 * @param host
 * @param encodeCreate
 * @param encodeRpc
 * @param encodeTransaction
 * @param describe
 * @param-[strict]
 */
function MediaObjectCreator(host, encodeCreate, encodeRpc, encodeTransaction,
  describe, strict) {
  if (!(this instanceof MediaObjectCreator))
    return new MediaObjectCreator(host, encodeCreate, encodeRpc,
      encodeTransaction, describe)

  /**
   * @param constructor
   *
   * @return {module:core/abstracts.MediaObject}
   */
  function createObject(constructor) {
    var mediaObject = new constructor(strict)

    mediaObject.on('_describe', describe);
    mediaObject.on('_rpc', encodeRpc);

    if (mediaObject instanceof register.abstracts['kurento.Hub'] ||
      mediaObject instanceof register
      .classes['kurento.MediaPipeline'])
      mediaObject.on('_create', encodeCreate);

    if (mediaObject instanceof register.classes['kurento.MediaPipeline'])
      mediaObject.on('_transaction', encodeTransaction);

    return mediaObject;
  };

  /**
   * Request to the server to create a new MediaElement
   *
   * @param item
   * @param {module:kurentoClient~MediaObjectCreator~createMediaObjectCallback} [callback]
   */
  function createMediaObject(item, callback) {
    var transaction = item.transaction;
    delete item.transaction;

    var constructor = createConstructor(item, strict);

    item = constructor.item;
    delete constructor.item;

    var params = item.params || {};
    delete item.params;

    if (params.mediaPipeline == undefined && host instanceof register.classes
      .MediaPipeline)
      params.mediaPipeline = host;

    var params_ = extend({}, params)
    item.constructorParams = checkParams(params_, constructor.constructorParams,
      item.type);

    if (Object.keys(params_)) {
      item.properties = params_;
    }

    if (!Object.keys(item.constructorParams).length)
      delete item.constructorParams;

    try {
      var mediaObject = createObject(constructor)
    } catch (error) {
      return callback(error)
    };

    Object.defineProperty(item, 'object', {
      value: mediaObject
    });

    encodeCreate(transaction, item, callback);

    return mediaObject
  };
  /**
   * @callback module:kurentoClient~MediaObjectCreator~createMediaObjectCallback
   * @param {external:Error} error
   */

  /**
   * @method module:kurentoClient~MediaObjectCreator#create
   *
   * @param type
   * @param params
   * @param {module:kurentoClient~MediaObjectCreator~createCallback} [callback]
   */
  this.create = function (type, params, callback) {
    var transaction = (arguments[0] instanceof Transaction) ? Array.prototype
      .shift.apply(arguments) : undefined;

    switch (arguments.length) {
    case 1:
      params = undefined;
    case 2:
      callback = undefined;
    };

    // Fix optional parameters
    if (params instanceof Function) {
      if (callback)
        throw new SyntaxError("Nothing can be defined after the callback");

      callback = params;
      params = undefined;
    };

    if (type instanceof Array) {
      var createPipeline = false

      type.forEach(function (request) {
        var params = request.params || {}

        if (typeof params.mediaPipeline === 'number')
          createPipeline = true
      })

      function connectElements(error, elements) {
        if (error) return callback(error)

        if (params === true && host.connect)
          return host.connect(elements.filter(function (element) {
              try {
                checkMediaElement(element)
                return true
              } catch (e) {}
            }),
            function (error) {
              if (error) return callback(error)

              callback(null, elements)
            })

        callback(null, elements)
      }

      if (createPipeline)
        return host.transaction(function () {
          var mediaObjects = []

          async.map(type, function (request, callback) {
              var params = request.params || {}

              if (typeof params.mediaPipeline === 'number')
                params.mediaPipeline = mediaObjects[params
                  .mediaPipeline]

              mediaObjects.push(createMediaObject(request, callback))
            },
            connectElements)
        })

      return createPromise(type, createMediaObject, connectElements)
    }

    type = {
      params: params,
      transaction: transaction,
      type: type
    };

    return createMediaObject(type, callback)
  };
  /**
   * @callback module:kurentoClient~MediaObjectCreator~createCallback
   *
   * @param {external:Error} error
   * @param {module:core/abstracts.MediaObject} mediaObject
   *  The created MediaObject
   */

  /**
   * @method module:kurentoClient~MediaObjectCreator#createInmediate
   *
   * @param item
   */
  this.createInmediate = function (item) {
    var constructor = createConstructor(item, strict);
    delete constructor.item;

    return createObject(constructor);
  }
}

module.exports = MediaObjectCreator;

},{"./TransactionsManager":3,"./checkType":5,"./createPromise":6,"./register":8,"async":"async","extend":22}],3:[function(require,module,exports){
/*
 * (C) Copyright 2013-2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var inherits = require('inherits');

var Domain = require('domain').Domain || (function () {
  function FakeDomain() {};
  inherits(FakeDomain, require('events').EventEmitter);
  FakeDomain.prototype.run = function (fn) {
    try {
      fn()
    } catch (err) {
      this.emit('error', err)
    };
    return this;
  };
  return FakeDomain;
})();

var promiseCallback = require('promisecallback');

function onerror(error) {
  this._transactionError = error;
}

function TransactionNotExecutedException(message) {
  TransactionNotExecutedException.super_.call(this, message);
};
inherits(TransactionNotExecutedException, Error);

function TransactionNotCommitedException(message) {
  TransactionNotCommitedException.super_.call(this, message);
};
inherits(TransactionNotCommitedException, TransactionNotExecutedException);

function TransactionRollbackException(message) {
  TransactionRollbackException.super_.call(this, message);
};
inherits(TransactionRollbackException, TransactionNotExecutedException);

function Transaction(commit) {
  Transaction.super_.call(this);

  var operations = [];

  Object.defineProperty(this, 'length', {
    get: function () {
      return operations.length
    }
  });

  this.push = operations.push.bind(operations);

  Object.defineProperty(this, 'commited', {
    configurable: true,
    value: false
  });

  this.commit = function (callback) {
    if (this.exit) this.exit();
    this.removeListener('error', onerror);

    var promise;

    if (this._transactionError)
      promise = Promise.reject(this._transactionError)

    else {
      operations.forEach(function (operation) {
        var object = operation.params.object;
        if (object && object.transactions) {
          object.transactions.shift();

          if (!object.transactions)
            delete object.transactions;
        }
      });

      var self = this;

      promise = new Promise(function (resolve, reject) {
        function callback(error, result) {
          Object.defineProperty(self, 'commited', {
            value: error == undefined
          });

          if (error) return reject(error);

          resolve(result)
        }

        commit(operations, callback);
      })
    }

    promise = promiseCallback(promise, callback)

    this.catch = promise.catch.bind(promise);
    this.then = promise.then.bind(promise);

    delete this.push;
    delete this.commit;
    delete this.endTransaction;

    return this;
  }

  this.rollback = function (callback) {
    Object.defineProperty(this, 'commited', {
      value: false
    });

    var error = new TransactionRollbackException(
      'Transaction rollback by user');

    // Notify error to all the operations in the transaction
    operations.forEach(function (operation) {
      if (operation.method == 'create')
        operation.params.object.emit('_id', error);

      var callback = operation.callback;
      if (callback instanceof Function)
        callback(error);
    });

    if (callback instanceof Function)
      callback(error);

    return this;
  };

  // Errors during transaction execution go to the callback,
  // user will register 'error' event for async errors later
  this.once('error', onerror);
  if (this.enter) this.enter();
}
inherits(Transaction, Domain);

function TransactionsManager(host, commit) {
  var transactions = [];

  Object.defineProperty(this, 'length', {
    get: function () {
      return transactions.length
    }
  });

  this.beginTransaction = function () {
    var transaction = new Transaction(commit);
    //    transactions.unshift(transaction);
    return transaction;
  };

  this.endTransaction = function (callback) {
    //    return transactions.shift().commit(callback);
  };

  this.transaction = function (func, callback) {
    var transaction = this.beginTransaction();
    transactions.unshift(transaction);

    transaction.run(func.bind(host));

    return transactions.shift().commit(callback);
    //    return this.endTransaction(callback)
  };

  this.push = function (data) {
    transactions[0].push(data);
  }
};

function transactionOperation(method, params, callback) {
  var operation = {
    method: method,
    params: params,
    callback: callback
  }

  var object = params.object;
  if (object) {
    if (object.transactions) {
      object.transactions.unshift(this)
    } else {
      Object.defineProperty(object, 'transactions', {
        configurable: true,
        value: [this]
      });
    }
  }

  this.push(operation);
};

module.exports = TransactionsManager;

TransactionsManager.Transaction = Transaction;
TransactionsManager.transactionOperation = transactionOperation;
TransactionsManager.TransactionNotExecutedException =
  TransactionNotExecutedException;
TransactionsManager.TransactionNotCommitedException =
  TransactionNotCommitedException;
TransactionsManager.TransactionRollbackException = TransactionRollbackException;

},{"domain":19,"events":21,"inherits":"inherits","promisecallback":"promisecallback"}],4:[function(require,module,exports){
/**
 * Loader for the kurento-client package on the browser
 */

if (typeof kurentoClient == 'undefined')
  window.kurentoClient = require('.');

},{".":"kurento-client"}],5:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/**
 * Number.isInteger() polyfill
 * @function external:Number#isInteger
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/isInteger Number.isInteger}
 */
if (!Number.isInteger) {
  Number.isInteger = function isInteger(nVal) {
    return typeof nVal === "number" && isFinite(nVal) && nVal > -
      9007199254740992 && nVal < 9007199254740992 && Math.floor(nVal) ===
      nVal;
  };
}

function ChecktypeError(key, type, value) {
  return SyntaxError(key + ' param should be a ' + (type.name || type) +
    ', not ' + value.constructor.name);
}

//
// Basic types
//

function checkArray(type, key, value) {
  if (!(value instanceof Array))
    throw ChecktypeError(key, 'Array of ' + type, value);

  value.forEach(function (item, i) {
    checkType(type, key + '[' + i + ']', item);
  })
};

function checkBoolean(key, value) {
  if (typeof value != 'boolean')
    throw ChecktypeError(key, Boolean, value);
};

function checkNumber(key, value) {
  if (typeof value != 'number')
    throw ChecktypeError(key, Number, value);
};

function checkInteger(key, value) {
  if (!Number.isInteger(value))
    throw ChecktypeError(key, 'Integer', value);
};

function checkObject(key, value) {
  if (typeof value != 'object')
    throw ChecktypeError(key, Object, value);
};

function checkString(key, value) {
  if (typeof value != 'string')
    throw ChecktypeError(key, String, value);
};

// Checker functions

function checkType(type, key, value, options) {
  options = options || {};

  if (value != undefined) {
    if (options.isArray)
      return checkArray(type, key, value);

    var checker = checkType[type];
    if (checker) return checker(key, value);

    console.warn("Could not check " + key + ", unknown type " + type);
    //    throw TypeError("Could not check "+key+", unknown type "+type);
  } else if (options.required)
    throw SyntaxError(key + " param is required");

};

function checkParams(params, scheme, class_name) {
  var result = {};

  // check MediaObject params
  for (var key in scheme) {
    var value = params[key];

    var s = scheme[key];

    checkType(s.type, key, value, s);

    if (value == undefined) continue;

    result[key] = value;
    delete params[key];
  };

  return result;
};

function checkMethodParams(callparams, method_params) {
  var result = {};

  var index = 0,
    param;
  for (; param = method_params[index]; index++) {
    var key = param.name;
    var value = callparams[index];

    checkType(param.type, key, value, param);

    result[key] = value;
  }

  var params = callparams.slice(index);
  if (params.length)
    console.warning('Unused params:', params);

  return result;
};

module.exports = checkType;

checkType.checkArray = checkArray;
checkType.checkParams = checkParams;
checkType.ChecktypeError = ChecktypeError;

// Basic types

checkType.boolean = checkBoolean;
checkType.double = checkNumber;
checkType.float = checkNumber;
checkType.int = checkInteger;
checkType.Object = checkObject;
checkType.String = checkString;

},{}],6:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var async = require('async');
var disguise = require('./disguise')
var promiseCallback = require('promisecallback');

function createPromise(data, func, callback) {
  var promise = new Promise(function (resolve, reject) {
    function callback2(error, result) {
      if (error) return reject(error);
      //resolve(result)
      resolve(disguise.unthenable(result));
    };

    if (data instanceof Array)
      async.map(data, func, callback2);
    else
      func(data, callback2);
  });

  return promiseCallback(promise, callback);
};

module.exports = createPromise;

},{"./disguise":7,"async":"async","promisecallback":"promisecallback"}],7:[function(require,module,exports){
/**
 * Generic `Promise.catch()` method
 *
 * It delegate its functionality on the `then()` of the object where it's
 * applied, both directly or on its class definition prototype
 *
 * @param {Function} [onRejected]
 *
 * @return {Promise}
 */
function promiseCatch(onRejected) {
  return this.then(null, onRejected)
}

//
// Public API
//

/**
 * Disguise an object giving it the appearance of another
 *
 * Add bind'ed functions and properties to a `target` object delegating the
 * actions and attributes updates to the `source` one while retaining its
 * original personality (i.e. duplicates and `instanceof` are preserved)
 *
 * @param {Object} target - the object to be disguised
 * @param {Object} source - the object where to fetch its methods and attributes
 * @param {Object} [unthenable] - the returned object should not be a thenable
 *
 * @return {Object} `target` disguised
 */
function disguise(target, source, unthenable) {
  if (source == null || target === source) return target

  for (var key in source) {
    if (target[key] !== undefined) continue
    if (unthenable && (key === 'then' || key === 'catch')) continue

    if (typeof source[key] === 'function')
      var descriptor = {
        value: source[key]
      }
    else
      var descriptor = {
        get: function () {
          return source[key]
        },
        set: function (value) {
          source[key] = value
        }
      }

    descriptor.enumerable = true

    Object.defineProperty(target, key, descriptor)
  }
  return target
}

/**
 * Disguise a thenable object
 *
 * If available, `target.then()` gets replaced by a method that exec the
 * `onFulfilled` and `onRejected` callbacks using `source` as `this` object, and
 * return the Promise returned by the original `target.then()` method already
 * disguised. It also add a `target.catch()` method pointing to the newly added
 * `target.then()`, being it previously available or not.
 *
 * @param {thenable} target - the object to be disguised
 * @param {Object} source - the object where to fetch its methods and attributes
 *
 * @return {thenable} `target` disguised
 */
function disguiseThenable(target, source) {
  if (target === source) return target

  if (target.then instanceof Function) {
    var target_then = target.then

    function then(onFulfilled, onRejected) {
      if (onFulfilled != null) onFulfilled = onFulfilled.bind(target)
      if (onRejected != null) onRejected = onRejected.bind(target)

      var promise = target_then.call(target, onFulfilled, onRejected)

      return disguiseThenable(promise, source)
    }

    Object.defineProperties(target, {
      then: {
        value: then
      },
      catch: {
        value: promiseCatch
      }
    })
  }

  return disguise(target, source)
}

/**
 * Return a copy of the input object without `.then()` and `.catch()`
 *
 * @param {thenable} input
 *
 * @return {Object} unthenabled input object
 */
function unthenable(input) {
  var output = Object.assign({}, input)
  delete output.then
  if (input !== undefined)
    output.constructor = input.constructor

  if (input && input.then instanceof Function) return disguise(output, input,
    true)

  // `input` is not thenable
  return input
}

disguiseThenable.disguise = disguise
disguiseThenable.disguiseThenable = disguiseThenable
disguiseThenable.unthenable = unthenable

module.exports = disguiseThenable

},{}],8:[function(require,module,exports){
var checkType = require('./checkType');

var abstracts = {};
var classes = {};
var complexTypes = {};
var modules = [];

function registerAbstracts(classes, hierarchy) {
  for (var name in classes) {
    var constructor = classes[name]

    // Register constructor checker
    var check = constructor.check;
    if (check) checkType[name] = check;

    // Register constructor
    abstracts[name] = constructor;
    abstracts[hierarchy + "." + name] = constructor;
  }
}

function registerClass(name, constructor) {
  // Register constructor checker
  var check = constructor.check;
  if (check) checkType[name] = check;

  // Register constructor
  classes[name] = constructor;
}

function registerComplexTypes(types, hierarchy) {
  for (var name in types) {
    var constructor = types[name]

    // Register constructor checker
    var check = constructor.check;
    if (check) {
      checkType[name] = check;
      checkType[hierarchy + "." + name] = check;

      // Register constructor
      complexTypes[name] = constructor;
      complexTypes[hierarchy + "." + name] = constructor;
    } else {
      checkType[name] = constructor;
      checkType[hierarchy + "." + name] = constructor;
    }
  }
}

function registerModule(name) {
  modules.push(name)
  modules.sort()
}

function register(name, constructor) {
  // Adjust parameters
  if (!name)
    throw SyntaxError('Need to define an object, a module or a function')

  if (typeof name != 'string') {
    constructor = name
    name = undefined
  }

  // Execute require if we only have a name
  if (constructor == undefined)
    return register(require(name));

  // Execute require if the constructor is set as a string
  if (typeof constructor === 'string')
    return register(name, require(constructor));

  // Registering a function
  if (constructor instanceof Function) {
    // Registration name
    if (!name) name = constructor.name

    if (name == undefined)
      throw new SyntaxError("Can't register an anonymous module");

    return registerClass(name, constructor)
  }

  // Registering a plugin
  if (!name) name = constructor.name

  if (name) registerModule(name)

  for (var key in constructor) {
    var value = constructor[key]

    if (name === 'core' || name === 'elements' || name === 'filters')
      name = 'kurento'
    var hierarchy = name + "." + key;

    if (typeof value !== 'string')
      switch (key) {
      case 'abstracts':
        registerAbstracts(value, name)
        break

      case 'complexTypes':
        registerComplexTypes(value, name)
        break

      default:
        registerClass(hierarchy, value)
        registerClass(key, value)
      }
  }
};

module.exports = register;

register.abstracts = abstracts;
register.classes = classes;
register.complexTypes = complexTypes;
register.modules = modules;

},{"./checkType":5}],9:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var Backoff = require('./lib/backoff');
var ExponentialBackoffStrategy = require('./lib/strategy/exponential');
var FibonacciBackoffStrategy = require('./lib/strategy/fibonacci');
var FunctionCall = require('./lib/function_call.js');

module.exports.Backoff = Backoff;
module.exports.FunctionCall = FunctionCall;
module.exports.FibonacciStrategy = FibonacciBackoffStrategy;
module.exports.ExponentialStrategy = ExponentialBackoffStrategy;

/**
 * Constructs a Fibonacci backoff.
 * @param options Fibonacci backoff strategy arguments.
 * @return The fibonacci backoff.
 * @see FibonacciBackoffStrategy
 */
module.exports.fibonacci = function(options) {
    return new Backoff(new FibonacciBackoffStrategy(options));
};

/**
 * Constructs an exponential backoff.
 * @param options Exponential strategy arguments.
 * @return The exponential backoff.
 * @see ExponentialBackoffStrategy
 */
module.exports.exponential = function(options) {
    return new Backoff(new ExponentialBackoffStrategy(options));
};

/**
 * Constructs a FunctionCall for the given function and arguments.
 * @param fn The function to wrap in a backoff handler.
 * @param vargs The function's arguments (var args).
 * @param callback The function's callback.
 * @return The FunctionCall instance.
 */
module.exports.call = function(fn, vargs, callback) {
    var args = Array.prototype.slice.call(arguments);
    fn = args[0];
    vargs = args.slice(1, args.length - 1);
    callback = args[args.length - 1];
    return new FunctionCall(fn, vargs, callback);
};

},{"./lib/backoff":10,"./lib/function_call.js":11,"./lib/strategy/exponential":12,"./lib/strategy/fibonacci":13}],10:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var events = require('events');
var util = require('util');

/**
 * Backoff driver.
 * @param backoffStrategy Backoff delay generator/strategy.
 * @constructor
 */
function Backoff(backoffStrategy) {
    events.EventEmitter.call(this);

    this.backoffStrategy_ = backoffStrategy;
    this.maxNumberOfRetry_ = -1;
    this.backoffNumber_ = 0;
    this.backoffDelay_ = 0;
    this.timeoutID_ = -1;

    this.handlers = {
        backoff: this.onBackoff_.bind(this)
    };
}
util.inherits(Backoff, events.EventEmitter);

/**
 * Sets a limit, greater than 0, on the maximum number of backoffs. A 'fail'
 * event will be emitted when the limit is reached.
 * @param maxNumberOfRetry The maximum number of backoffs.
 */
Backoff.prototype.failAfter = function(maxNumberOfRetry) {
    if (maxNumberOfRetry < 1) {
        throw new Error('Maximum number of retry must be greater than 0. ' +
                        'Actual: ' + maxNumberOfRetry);
    }

    this.maxNumberOfRetry_ = maxNumberOfRetry;
};

/**
 * Starts a backoff operation.
 * @param err Optional paramater to let the listeners know why the backoff
 *     operation was started.
 */
Backoff.prototype.backoff = function(err) {
    if (this.timeoutID_ !== -1) {
        throw new Error('Backoff in progress.');
    }

    if (this.backoffNumber_ === this.maxNumberOfRetry_) {
        this.emit('fail', err);
        this.reset();
    } else {
        this.backoffDelay_ = this.backoffStrategy_.next();
        this.timeoutID_ = setTimeout(this.handlers.backoff, this.backoffDelay_);
        this.emit('backoff', this.backoffNumber_, this.backoffDelay_, err);
    }
};

/**
 * Handles the backoff timeout completion.
 * @private
 */
Backoff.prototype.onBackoff_ = function() {
    this.timeoutID_ = -1;
    this.emit('ready', this.backoffNumber_, this.backoffDelay_);
    this.backoffNumber_++;
};

/**
 * Stops any backoff operation and resets the backoff delay to its inital
 * value.
 */
Backoff.prototype.reset = function() {
    this.backoffNumber_ = 0;
    this.backoffStrategy_.reset();
    clearTimeout(this.timeoutID_);
    this.timeoutID_ = -1;
};

module.exports = Backoff;

},{"events":21,"util":151}],11:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var events = require('events');
var util = require('util');

var Backoff = require('./backoff');
var FibonacciBackoffStrategy = require('./strategy/fibonacci');

/**
 * Returns true if the specified value is a function
 * @param val Variable to test.
 * @return Whether variable is a function.
 */
function isFunction(val) {
    return typeof val == 'function';
}

/**
 * Manages the calling of a function in a backoff loop.
 * @param fn Function to wrap in a backoff handler.
 * @param args Array of function's arguments.
 * @param callback Function's callback.
 * @constructor
 */
function FunctionCall(fn, args, callback) {
    events.EventEmitter.call(this);

    if (!isFunction(fn)) {
        throw new Error('fn should be a function.' +
                        'Actual: ' + typeof fn);
    }

    if (!isFunction(callback)) {
        throw new Error('callback should be a function.' +
                        'Actual: ' + typeof fn);
    }

    this.function_ = fn;
    this.arguments_ = args;
    this.callback_ = callback;
    this.results_ = [];

    this.backoff_ = null;
    this.strategy_ = null;
    this.failAfter_ = -1;

    this.state_ = FunctionCall.State_.PENDING;
}
util.inherits(FunctionCall, events.EventEmitter);

/**
 * Enum of states in which the FunctionCall can be.
 * @private
 */
FunctionCall.State_ = {
    PENDING: 0,
    RUNNING: 1,
    COMPLETED: 2,
    ABORTED: 3
};

/**
 * @return Whether the call is pending.
 */
FunctionCall.prototype.isPending = function() {
    return this.state_ == FunctionCall.State_.PENDING;
};

/**
 * @return Whether the call is in progress.
 */
FunctionCall.prototype.isRunning = function() {
    return this.state_ == FunctionCall.State_.RUNNING;
};

/**
 * @return Whether the call is completed.
 */
FunctionCall.prototype.isCompleted = function() {
    return this.state_ == FunctionCall.State_.COMPLETED;
};

/**
 * @return Whether the call is aborted.
 */
FunctionCall.prototype.isAborted = function() {
    return this.state_ == FunctionCall.State_.ABORTED;
};

/**
 * Sets the backoff strategy.
 * @param strategy The backoff strategy to use.
 * @return Itself for chaining.
 */
FunctionCall.prototype.setStrategy = function(strategy) {
    if (!this.isPending()) {
        throw new Error('FunctionCall in progress.');
    }
    this.strategy_ = strategy;
    return this;
};

/**
 * Returns all intermediary results returned by the wrapped function since
 * the initial call.
 * @return An array of intermediary results.
 */
FunctionCall.prototype.getResults = function() {
    return this.results_.concat();
};

/**
 * Sets the backoff limit.
 * @param maxNumberOfRetry The maximum number of backoffs.
 * @return Itself for chaining.
 */
FunctionCall.prototype.failAfter = function(maxNumberOfRetry) {
    if (!this.isPending()) {
        throw new Error('FunctionCall in progress.');
    }
    this.failAfter_ = maxNumberOfRetry;
    return this;
};

/**
 * Aborts the call.
 */
FunctionCall.prototype.abort = function() {
    if (this.isCompleted()) {
        throw new Error('FunctionCall already completed.');
    }

    if (this.isRunning()) {
        this.backoff_.reset();
    }

    this.state_ = FunctionCall.State_.ABORTED;
};

/**
 * Initiates the call to the wrapped function.
 * @param backoffFactory Optional factory function used to create the backoff
 *     instance.
 */
FunctionCall.prototype.start = function(backoffFactory) {
    if (this.isAborted()) {
        throw new Error('FunctionCall aborted.');
    } else if (!this.isPending()) {
        throw new Error('FunctionCall already started.');
    }

    var strategy = this.strategy_ || new FibonacciBackoffStrategy();

    this.backoff_ = backoffFactory ?
        backoffFactory(strategy) :
        new Backoff(strategy);

    this.backoff_.on('ready', this.doCall_.bind(this));
    this.backoff_.on('fail', this.doCallback_.bind(this));
    this.backoff_.on('backoff', this.handleBackoff_.bind(this));

    if (this.failAfter_ > 0) {
        this.backoff_.failAfter(this.failAfter_);
    }

    this.state_ = FunctionCall.State_.RUNNING;
    this.doCall_();
};

/**
 * Calls the wrapped function.
 * @private
 */
FunctionCall.prototype.doCall_ = function() {
    var eventArgs = ['call'].concat(this.arguments_);
    events.EventEmitter.prototype.emit.apply(this, eventArgs);
    var callback = this.handleFunctionCallback_.bind(this);
    this.function_.apply(null, this.arguments_.concat(callback));
};

/**
 * Calls the wrapped function's callback with the last result returned by the
 * wrapped function.
 * @private
 */
FunctionCall.prototype.doCallback_ = function() {
    var args = this.results_[this.results_.length - 1];
    this.callback_.apply(null, args);
};

/**
 * Handles wrapped function's completion. This method acts as a replacement
 * for the original callback function.
 * @private
 */
FunctionCall.prototype.handleFunctionCallback_ = function() {
    if (this.isAborted()) {
        return;
    }

    var args = Array.prototype.slice.call(arguments);
    this.results_.push(args); // Save callback arguments.
    events.EventEmitter.prototype.emit.apply(this, ['callback'].concat(args));

    if (args[0]) {
        this.backoff_.backoff(args[0]);
    } else {
        this.state_ = FunctionCall.State_.COMPLETED;
        this.doCallback_();
    }
};

/**
 * Handles backoff event.
 * @param number Backoff number.
 * @param delay Backoff delay.
 * @param err The error that caused the backoff.
 * @private
 */
FunctionCall.prototype.handleBackoff_ = function(number, delay, err) {
    this.emit('backoff', number, delay, err);
};

module.exports = FunctionCall;

},{"./backoff":10,"./strategy/fibonacci":13,"events":21,"util":151}],12:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var util = require('util');

var BackoffStrategy = require('./strategy');

/**
 * Exponential backoff strategy.
 * @extends BackoffStrategy
 */
function ExponentialBackoffStrategy(options) {
    BackoffStrategy.call(this, options);
    this.backoffDelay_ = 0;
    this.nextBackoffDelay_ = this.getInitialDelay();
}
util.inherits(ExponentialBackoffStrategy, BackoffStrategy);

/** @inheritDoc */
ExponentialBackoffStrategy.prototype.next_ = function() {
    this.backoffDelay_ = Math.min(this.nextBackoffDelay_, this.getMaxDelay());
    this.nextBackoffDelay_ = this.backoffDelay_ * 2;
    return this.backoffDelay_;
};

/** @inheritDoc */
ExponentialBackoffStrategy.prototype.reset_ = function() {
    this.backoffDelay_ = 0;
    this.nextBackoffDelay_ = this.getInitialDelay();
};

module.exports = ExponentialBackoffStrategy;

},{"./strategy":14,"util":151}],13:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var util = require('util');

var BackoffStrategy = require('./strategy');

/**
 * Fibonacci backoff strategy.
 * @extends BackoffStrategy
 */
function FibonacciBackoffStrategy(options) {
    BackoffStrategy.call(this, options);
    this.backoffDelay_ = 0;
    this.nextBackoffDelay_ = this.getInitialDelay();
}
util.inherits(FibonacciBackoffStrategy, BackoffStrategy);

/** @inheritDoc */
FibonacciBackoffStrategy.prototype.next_ = function() {
    var backoffDelay = Math.min(this.nextBackoffDelay_, this.getMaxDelay());
    this.nextBackoffDelay_ += this.backoffDelay_;
    this.backoffDelay_ = backoffDelay;
    return backoffDelay;
};

/** @inheritDoc */
FibonacciBackoffStrategy.prototype.reset_ = function() {
    this.nextBackoffDelay_ = this.getInitialDelay();
    this.backoffDelay_ = 0;
};

module.exports = FibonacciBackoffStrategy;

},{"./strategy":14,"util":151}],14:[function(require,module,exports){
/*
 * Copyright (c) 2012 Mathieu Turcotte
 * Licensed under the MIT license.
 */

var events = require('events');
var util = require('util');

function isDef(value) {
    return value !== undefined && value !== null;
}

/**
 * Abstract class defining the skeleton for all backoff strategies.
 * @param options Backoff strategy options.
 * @param options.randomisationFactor The randomisation factor, must be between
 * 0 and 1.
 * @param options.initialDelay The backoff initial delay, in milliseconds.
 * @param options.maxDelay The backoff maximal delay, in milliseconds.
 * @constructor
 */
function BackoffStrategy(options) {
    options = options || {};

    if (isDef(options.initialDelay) && options.initialDelay < 1) {
        throw new Error('The initial timeout must be greater than 0.');
    } else if (isDef(options.maxDelay) && options.maxDelay < 1) {
        throw new Error('The maximal timeout must be greater than 0.');
    }

    this.initialDelay_ = options.initialDelay || 100;
    this.maxDelay_ = options.maxDelay || 10000;

    if (this.maxDelay_ <= this.initialDelay_) {
        throw new Error('The maximal backoff delay must be ' +
                        'greater than the initial backoff delay.');
    }

    if (isDef(options.randomisationFactor) &&
        (options.randomisationFactor < 0 || options.randomisationFactor > 1)) {
        throw new Error('The randomisation factor must be between 0 and 1.');
    }

    this.randomisationFactor_ = options.randomisationFactor || 0;
}

/**
 * Retrieves the maximal backoff delay.
 * @return The maximal backoff delay, in milliseconds.
 */
BackoffStrategy.prototype.getMaxDelay = function() {
    return this.maxDelay_;
};

/**
 * Retrieves the initial backoff delay.
 * @return The initial backoff delay, in milliseconds.
 */
BackoffStrategy.prototype.getInitialDelay = function() {
    return this.initialDelay_;
};

/**
 * Template method that computes the next backoff delay.
 * @return The backoff delay, in milliseconds.
 */
BackoffStrategy.prototype.next = function() {
    var backoffDelay = this.next_();
    var randomisationMultiple = 1 + Math.random() * this.randomisationFactor_;
    var randomizedDelay = Math.round(backoffDelay * randomisationMultiple);
    return randomizedDelay;
};

/**
 * Computes the next backoff delay.
 * @return The backoff delay, in milliseconds.
 * @protected
 */
BackoffStrategy.prototype.next_ = function() {
    throw new Error('BackoffStrategy.next_() unimplemented.');
};

/**
 * Template method that resets the backoff delay to its initial value.
 */
BackoffStrategy.prototype.reset = function() {
    this.reset_();
};

/**
 * Resets the backoff delay to its initial value.
 * @protected
 */
BackoffStrategy.prototype.reset_ = function() {
    throw new Error('BackoffStrategy.reset_() unimplemented.');
};

module.exports = BackoffStrategy;

},{"events":21,"util":151}],15:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  for (var i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],16:[function(require,module,exports){

},{}],17:[function(require,module,exports){
(function (Buffer){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this,require("buffer").Buffer)
},{"base64-js":15,"buffer":17,"ieee754":23}],18:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":require("../../is-buffer/index.js")})
},{"../../is-buffer/index.js":24}],19:[function(require,module,exports){
// This file should be ES5 compatible
/* eslint prefer-spread:0, no-var:0, prefer-reflect:0, no-magic-numbers:0 */
'use strict'

module.exports = (function () {
	// Import Events
	var events = require('events')

	// Export Domain
	var domain = {}
	domain.createDomain = domain.create = function () {
		var d = new events.EventEmitter()

		function emitError (e) {
			d.emit('error', e)
		}

		d.add = function (emitter) {
			emitter.on('error', emitError)
		}
		d.remove = function (emitter) {
			emitter.removeListener('error', emitError)
		}
		d.bind = function (fn) {
			return function () {
				var args = Array.prototype.slice.call(arguments)
				try {
					fn.apply(null, args)
				}
				catch (err) {
					emitError(err)
				}
			}
		}
		d.intercept = function (fn) {
			return function (err) {
				if ( err ) {
					emitError(err)
				}
				else {
					var args = Array.prototype.slice.call(arguments, 1)
					try {
						fn.apply(null, args)
					}
					catch (err) {
						emitError(err)
					}
				}
			}
		}
		d.run = function (fn) {
			try {
				fn()
			}
			catch (err) {
				emitError(err)
			}
			return this
		}
		d.dispose = function () {
			this.removeAllListeners()
			return this
		}
		d.enter = d.exit = function () {
			return this
		}
		return d
	}
	return domain
}).call(this)

},{"events":21}],20:[function(require,module,exports){
Object.defineProperty(Error.prototype, 'toJSON', {
    value: function () {
        var alt = {};

        Object.getOwnPropertyNames(this).forEach(function (key) {
            alt[key] = this[key];
        }, this);

        return alt;
    },
    configurable: true
});

},{}],21:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var objectCreate = Object.create || objectCreatePolyfill
var objectKeys = Object.keys || objectKeysPolyfill
var bind = Function.prototype.bind || functionBindPolyfill

function EventEmitter() {
  if (!this._events || !Object.prototype.hasOwnProperty.call(this, '_events')) {
    this._events = objectCreate(null);
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
var defaultMaxListeners = 10;

var hasDefineProperty;
try {
  var o = {};
  if (Object.defineProperty) Object.defineProperty(o, 'x', { value: 0 });
  hasDefineProperty = o.x === 0;
} catch (err) { hasDefineProperty = false }
if (hasDefineProperty) {
  Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
    enumerable: true,
    get: function() {
      return defaultMaxListeners;
    },
    set: function(arg) {
      // check whether the input is a positive number (whose value is zero or
      // greater and not a NaN).
      if (typeof arg !== 'number' || arg < 0 || arg !== arg)
        throw new TypeError('"defaultMaxListeners" must be a positive number');
      defaultMaxListeners = arg;
    }
  });
} else {
  EventEmitter.defaultMaxListeners = defaultMaxListeners;
}

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || isNaN(n))
    throw new TypeError('"n" argument must be a positive number');
  this._maxListeners = n;
  return this;
};

function $getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return $getMaxListeners(this);
};

// These standalone emit* functions are used to optimize calling of event
// handlers for fast cases because emit() itself often has a variable number of
// arguments and can be deoptimized because of that. These functions always have
// the same number of arguments and thus do not get deoptimized, so the code
// inside them can execute faster.
function emitNone(handler, isFn, self) {
  if (isFn)
    handler.call(self);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self);
  }
}
function emitOne(handler, isFn, self, arg1) {
  if (isFn)
    handler.call(self, arg1);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1);
  }
}
function emitTwo(handler, isFn, self, arg1, arg2) {
  if (isFn)
    handler.call(self, arg1, arg2);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2);
  }
}
function emitThree(handler, isFn, self, arg1, arg2, arg3) {
  if (isFn)
    handler.call(self, arg1, arg2, arg3);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2, arg3);
  }
}

function emitMany(handler, isFn, self, args) {
  if (isFn)
    handler.apply(self, args);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].apply(self, args);
  }
}

EventEmitter.prototype.emit = function emit(type) {
  var er, handler, len, args, i, events;
  var doError = (type === 'error');

  events = this._events;
  if (events)
    doError = (doError && events.error == null);
  else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    if (arguments.length > 1)
      er = arguments[1];
    if (er instanceof Error) {
      throw er; // Unhandled 'error' event
    } else {
      // At least give some kind of context to the user
      var err = new Error('Unhandled "error" event. (' + er + ')');
      err.context = er;
      throw err;
    }
    return false;
  }

  handler = events[type];

  if (!handler)
    return false;

  var isFn = typeof handler === 'function';
  len = arguments.length;
  switch (len) {
      // fast cases
    case 1:
      emitNone(handler, isFn, this);
      break;
    case 2:
      emitOne(handler, isFn, this, arguments[1]);
      break;
    case 3:
      emitTwo(handler, isFn, this, arguments[1], arguments[2]);
      break;
    case 4:
      emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
      break;
      // slower
    default:
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];
      emitMany(handler, isFn, this, args);
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  var m;
  var events;
  var existing;

  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');

  events = target._events;
  if (!events) {
    events = target._events = objectCreate(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener) {
      target.emit('newListener', type,
          listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (!existing) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
          prepend ? [listener, existing] : [existing, listener];
    } else {
      // If we've already got an array, just append.
      if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
    }

    // Check for listener leak
    if (!existing.warned) {
      m = $getMaxListeners(target);
      if (m && m > 0 && existing.length > m) {
        existing.warned = true;
        var w = new Error('Possible EventEmitter memory leak detected. ' +
            existing.length + ' "' + String(type) + '" listeners ' +
            'added. Use emitter.setMaxListeners() to ' +
            'increase limit.');
        w.name = 'MaxListenersExceededWarning';
        w.emitter = target;
        w.type = type;
        w.count = existing.length;
        if (typeof console === 'object' && console.warn) {
          console.warn('%s: %s', w.name, w.message);
        }
      }
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    switch (arguments.length) {
      case 0:
        return this.listener.call(this.target);
      case 1:
        return this.listener.call(this.target, arguments[0]);
      case 2:
        return this.listener.call(this.target, arguments[0], arguments[1]);
      case 3:
        return this.listener.call(this.target, arguments[0], arguments[1],
            arguments[2]);
      default:
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; ++i)
          args[i] = arguments[i];
        this.listener.apply(this.target, args);
    }
  }
}

function _onceWrap(target, type, listener) {
  var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
  var wrapped = bind.call(onceWrapper, state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      var list, events, position, i, originalListener;

      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');

      events = this._events;
      if (!events)
        return this;

      list = events[type];
      if (!list)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = objectCreate(null);
        else {
          delete events[type];
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        position = -1;

        for (i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else
          spliceOne(list, position);

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      var listeners, events, i;

      events = this._events;
      if (!events)
        return this;

      // not listening for removeListener, no need to emit
      if (!events.removeListener) {
        if (arguments.length === 0) {
          this._events = objectCreate(null);
          this._eventsCount = 0;
        } else if (events[type]) {
          if (--this._eventsCount === 0)
            this._events = objectCreate(null);
          else
            delete events[type];
        }
        return this;
      }

      // emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        var keys = objectKeys(events);
        var key;
        for (i = 0; i < keys.length; ++i) {
          key = keys[i];
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = objectCreate(null);
        this._eventsCount = 0;
        return this;
      }

      listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners) {
        // LIFO order
        for (i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  var events = target._events;

  if (!events)
    return [];

  var evlistener = events[type];
  if (!evlistener)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ? unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

EventEmitter.listenerCount = function(emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  var events = this._events;

  if (events) {
    var evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener) {
      return evlistener.length;
    }
  }

  return 0;
}

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

// About 1.5x faster than the two-arg version of Array#splice().
function spliceOne(list, index) {
  for (var i = index, k = i + 1, n = list.length; k < n; i += 1, k += 1)
    list[i] = list[k];
  list.pop();
}

function arrayClone(arr, n) {
  var copy = new Array(n);
  for (var i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function unwrapListeners(arr) {
  var ret = new Array(arr.length);
  for (var i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}

function objectCreatePolyfill(proto) {
  var F = function() {};
  F.prototype = proto;
  return new F;
}
function objectKeysPolyfill(obj) {
  var keys = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    keys.push(k);
  }
  return k;
}
function functionBindPolyfill(context) {
  var fn = this;
  return function () {
    return fn.apply(context, arguments);
  };
}

},{}],22:[function(require,module,exports){
'use strict';

var hasOwn = Object.prototype.hasOwnProperty;
var toStr = Object.prototype.toString;
var defineProperty = Object.defineProperty;
var gOPD = Object.getOwnPropertyDescriptor;

var isArray = function isArray(arr) {
	if (typeof Array.isArray === 'function') {
		return Array.isArray(arr);
	}

	return toStr.call(arr) === '[object Array]';
};

var isPlainObject = function isPlainObject(obj) {
	if (!obj || toStr.call(obj) !== '[object Object]') {
		return false;
	}

	var hasOwnConstructor = hasOwn.call(obj, 'constructor');
	var hasIsPrototypeOf = obj.constructor && obj.constructor.prototype && hasOwn.call(obj.constructor.prototype, 'isPrototypeOf');
	// Not own constructor property must be Object
	if (obj.constructor && !hasOwnConstructor && !hasIsPrototypeOf) {
		return false;
	}

	// Own properties are enumerated firstly, so to speed up,
	// if last one is own, then all properties are own.
	var key;
	for (key in obj) { /**/ }

	return typeof key === 'undefined' || hasOwn.call(obj, key);
};

// If name is '__proto__', and Object.defineProperty is available, define __proto__ as an own property on target
var setProperty = function setProperty(target, options) {
	if (defineProperty && options.name === '__proto__') {
		defineProperty(target, options.name, {
			enumerable: true,
			configurable: true,
			value: options.newValue,
			writable: true
		});
	} else {
		target[options.name] = options.newValue;
	}
};

// Return undefined instead of __proto__ if '__proto__' is not an own property
var getProperty = function getProperty(obj, name) {
	if (name === '__proto__') {
		if (!hasOwn.call(obj, name)) {
			return void 0;
		} else if (gOPD) {
			// In early versions of node, obj['__proto__'] is buggy when obj has
			// __proto__ as an own property. Object.getOwnPropertyDescriptor() works.
			return gOPD(obj, name).value;
		}
	}

	return obj[name];
};

module.exports = function extend() {
	var options, name, src, copy, copyIsArray, clone;
	var target = arguments[0];
	var i = 1;
	var length = arguments.length;
	var deep = false;

	// Handle a deep copy situation
	if (typeof target === 'boolean') {
		deep = target;
		target = arguments[1] || {};
		// skip the boolean and the target
		i = 2;
	}
	if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
		target = {};
	}

	for (; i < length; ++i) {
		options = arguments[i];
		// Only deal with non-null/undefined values
		if (options != null) {
			// Extend the base object
			for (name in options) {
				src = getProperty(target, name);
				copy = getProperty(options, name);

				// Prevent never-ending loop
				if (target !== copy) {
					// Recurse if we're merging plain objects or arrays
					if (deep && copy && (isPlainObject(copy) || (copyIsArray = isArray(copy)))) {
						if (copyIsArray) {
							copyIsArray = false;
							clone = src && isArray(src) ? src : [];
						} else {
							clone = src && isPlainObject(src) ? src : {};
						}

						// Never move original objects, clone them
						setProperty(target, { name: name, newValue: extend(deep, clone, copy) });

					// Don't bring in undefined values
					} else if (typeof copy !== 'undefined') {
						setProperty(target, { name: name, newValue: copy });
					}
				}
			}
		}
	}

	// Return the modified object
	return target;
};

},{}],23:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],24:[function(require,module,exports){
/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
module.exports = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
}

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}

},{}],25:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],26:[function(require,module,exports){
var Buffer = require('buffer').Buffer;

module.exports = isBuffer;

function isBuffer (o) {
  return Buffer.isBuffer(o)
    || /\[object (.+Array|Array.+)\]/.test(Object.prototype.toString.call(o));
}

},{"buffer":17}],27:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./abstracts/MediaElement');


/**
 * Creates a {@link module:core.HubPort HubPort} for the given {@link 
 * module:core/abstracts.Hub Hub}
 *
 * @classdesc
 *  This {@link module:core/abstracts.MediaElement MediaElement} specifies a 
 *  connection with a {@link module:core/abstracts.Hub Hub}
 *
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core.HubPort
 */
function HubPort(){
  HubPort.super_.call(this);
};
inherits(HubPort, MediaElement);


/**
 * @alias module:core.HubPort.constructorParams
 *
 * @property {module:core/abstracts.Hub} hub
 *  {@link module:core/abstracts.Hub Hub} to which this port belongs
 */
HubPort.constructorParams = {
  hub: {
    type: 'kurento.Hub',
    required: true
  }
};

/**
 * @alias module:core.HubPort.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
HubPort.events = MediaElement.events;


/**
 * Checker for {@link module:core.HubPort}
 *
 * @memberof module:core
 *
 * @param {external:String} key
 * @param {module:core.HubPort} value
 */
function checkHubPort(key, value)
{
  if(!(value instanceof HubPort))
    throw ChecktypeError(key, HubPort, value);
};


module.exports = HubPort;

HubPort.check = checkHubPort;

},{"./abstracts/MediaElement":34,"inherits":"inherits","kurento-client":"kurento-client"}],28:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var MediaObjectCreator  = kurentoClient.MediaObjectCreator;
var TransactionsManager = kurentoClient.TransactionsManager;

var transactionOperation = TransactionsManager.transactionOperation;

var MediaObject = require('./abstracts/MediaObject');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create a {@link module:core.MediaPipeline MediaPipeline}
 *
 * @classdesc
 *  A pipeline is a container for a collection of {@link 
 *  module:core/abstracts.MediaElement MediaElements} and 
 *  :rom:cls:`MediaMixers<MediaMixer>`. It offers the methods needed to control 
 *  the creation and connection of elements inside a certain pipeline.
 *
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core.MediaPipeline
 */
function MediaPipeline(strict){
  MediaPipeline.super_.call(this);


  var self = this;


  // Transactional API

  var transactionsManager = new TransactionsManager(this, encodeTransaction);

  this.beginTransaction = transactionsManager.beginTransaction.bind(transactionsManager);
  this.endTransaction   = transactionsManager.endTransaction.bind(transactionsManager);
  this.transaction      = transactionsManager.transaction.bind(transactionsManager);


  // Encode commands

  function encodeCreate(transaction, params, callback)
  {
    if(transaction)
      return transactionOperation.call(transaction, 'create', params, callback);

    if(transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'create', params, callback);

    self.emit('_create', undefined, params, callback)
  }

  function encodeRpc(transaction, method, params, callback)
  {
    if(transaction)
      return transactionOperation.call(transaction, method, params, callback);

    if(transactionsManager.length)
      return transactionOperation.call(transactionsManager, method, params, callback);

    self.emit('_rpc', undefined, method, params, callback)
  }

  function encodeTransaction(operations, callback)
  {
    var params =
    {
//      object: self,
      operations: operations
    };

    if(transactionsManager.length)
      return transactionOperation.call(transactionsManager, 'transaction', params, callback);

    self.emit('_transaction', params, callback);
  }

  var describe = this.emit.bind(this, '_describe');


  // Creation of objects

  var mediaObjectCreator = new MediaObjectCreator(this, encodeCreate, encodeRpc,
    encodeTransaction, describe, strict);

  /**
   * Create a new instance of a {module:core/abstract.MediaObject} attached to
   *  this {module:core.MediaPipeline}
   *
   * @param {external:String} type - Type of the
   *  {module:core/abstract.MediaObject}
   * @param {external:String[]} [params]
   * @param {module:core.MediaPipeline~createCallback} callback
   *
   * @return {external:Promise}
   */
  this.create = mediaObjectCreator.create.bind(mediaObjectCreator);
  /**
   * @callback core.MediaPipeline~createCallback
   * @param {external:Error} error
   * @param {module:core/abstract~MediaElement} result
   *  The created MediaElement
   */
};
inherits(MediaPipeline, MediaObject);


//
// Public properties
//

/**
 * If statistics about pipeline latency are enabled for all mediaElements
 *
 * @alias module:core.MediaPipeline#getLatencyStats
 *
 * @param {module:core.MediaPipeline~getLatencyStatsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaPipeline.prototype.getLatencyStats = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getLatencyStats', callback), this)
};
/**
 * @callback module:core.MediaPipeline~getLatencyStatsCallback
 * @param {external:Error} error
 * @param {external:Boolean} result
 */

/**
 * If statistics about pipeline latency are enabled for all mediaElements
 *
 * @alias module:core.MediaPipeline#setLatencyStats
 *
 * @param {external:Boolean} latencyStats
 * @param {module:core.MediaPipeline~setLatencyStatsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaPipeline.prototype.setLatencyStats = function(latencyStats, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('boolean', 'latencyStats', latencyStats, {required: true});
  //  

  var params = {
    latencyStats: latencyStats
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setLatencyStats', params, callback), this)
};
/**
 * @callback module:core.MediaPipeline~setLatencyStatsCallback
 * @param {external:Error} error
 */


//
// Public methods
//

/**
 * Returns a string in dot (graphviz) format that represents the gstreamer 
 * elements inside the pipeline
 *
 * @alias module:core.MediaPipeline.getGstreamerDot
 *
 * @param {module:core/complexTypes.GstreamerDotDetails} [details]
 *  Details of graph
 *
 * @param {module:core.MediaPipeline~getGstreamerDotCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaPipeline.prototype.getGstreamerDot = function(details, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: details = undefined;
    break;
    case 1: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-1]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 1;

      throw error;
  }

  //  
  // checkType('GstreamerDotDetails', 'details', details);
  //  

  var params = {
    details: details
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getGstreamerDot', params, callback), this)
};
/**
 * @callback module:core.MediaPipeline~getGstreamerDotCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The dot graph
 */


/**
 * Connect the source of a media to the sink of the next one
 *
 * @param {...module:core/abstract~MediaObject} media - A media to be connected
 * @callback {module:MediaPipeline~connectCallback} [callback]
 *
 * @return {external:Promise}
 *
 * @throws {SyntaxError}
 */
MediaPipeline.prototype.connect = function(media, callback){
  // Fix lenght-variable arguments
  if(!(media instanceof Array))
  {
    media = Array.prototype.slice.call(arguments, 0);
    callback = (typeof media[media.length - 1] === 'function')
             ? media.pop()
             : undefined;
  }

  callback = (callback || noop).bind(this)

  // Check if we have enought media components
  if(media.length < 2)
    throw new SyntaxError('Need at least two media elements to connect');

  return media[0].connect(media.slice(1), callback)
};
/**
 * @callback MediaPipeline~connectCallback
 * @param {external:Error} error
 */


/**
 * @alias module:core.MediaPipeline.constructorParams
 */
MediaPipeline.constructorParams = {
};

/**
 * @alias module:core.MediaPipeline.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
MediaPipeline.events = MediaObject.events;


/**
 * Checker for {@link module:core.MediaPipeline}
 *
 * @memberof module:core
 *
 * @param {external:String} key
 * @param {module:core.MediaPipeline} value
 */
function checkMediaPipeline(key, value)
{
  if(!(value instanceof MediaPipeline))
    throw ChecktypeError(key, MediaPipeline, value);
};


module.exports = MediaPipeline;

MediaPipeline.check = checkMediaPipeline;

},{"./abstracts/MediaObject":35,"inherits":"inherits","kurento-client":"kurento-client"}],29:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./abstracts/MediaElement');


/**
 * Builder for the {@link module:core.PassThrough PassThrough}
 *
 * @classdesc
 *  This {@link module:core/abstracts.MediaElement MediaElement} that just 
 *  passes media through
 *
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core.PassThrough
 */
function PassThrough(){
  PassThrough.super_.call(this);
};
inherits(PassThrough, MediaElement);


/**
 * @alias module:core.PassThrough.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the element 
 *  belongs
 */
PassThrough.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:core.PassThrough.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
PassThrough.events = MediaElement.events;


/**
 * Checker for {@link module:core.PassThrough}
 *
 * @memberof module:core
 *
 * @param {external:String} key
 * @param {module:core.PassThrough} value
 */
function checkPassThrough(key, value)
{
  if(!(value instanceof PassThrough))
    throw ChecktypeError(key, PassThrough, value);
};


module.exports = PassThrough;

PassThrough.check = checkPassThrough;

},{"./abstracts/MediaElement":34,"inherits":"inherits","kurento-client":"kurento-client"}],30:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var SdpEndpoint = require('./SdpEndpoint');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  This class extends from the SdpEndpoint, and handles RTP communications. All
 *        <ul style='list-style-type:circle'>
 *          <li>
 *            ConnectionStateChangedEvent: This event is raised when the 
 *            connection between two peers changes. It can have two values
 *            <ul>
 *              <li>CONNECTED</li>
 *              <li>DISCONNECTED</li>
 *            </ul>
 *          </li>
 *          <li>
 *            MediaStateChangedEvent: Based on RTCP packet flow, this event 
 *            provides more reliable information about the state of media flow. 
 *            Since RTCP packets are not flowing at a constant rate (minimizing 
 *            a browser with an RTCPeerConnection might affect this interval, 
 *            for instance), there is a guard period of about 5s. This traduces 
 *            in a period where there might be no media flowing, but the event 
 *            hasn't been fired yet. Nevertheless, this is the most reliable and
 *            <ul>
 *              <li>CONNECTED: There is an RTCP packet flow between peers.</li>
 *              <li>DISCONNECTED: No RTCP packets have been received, or at 
 *              least 5s have passed since the last packet arrived.</li>
 *            </ul>
 *          </li>
 *        </ul>
 *        Part of the bandwidth control of the video component of the media 
 *        session is done here. The values of the properties described are in 
 *        kbps.
 *        <ul style='list-style-type:circle'>
 *          <li>
 *            Input bandwidth control mechanism: Configuration interval used to 
 *            inform remote peer the range of bitrates that can be pushed into 
 *            this BaseRtpEndpoint object.
 *            <ul>
 *              <li>
 *                setMinVideoRecvBandwidth: sets min bitrate limits expected for
 *              </li>
 *            </ul>
 *            Max values are announced in the SDP, while min values are set to 
 *            limit the lower value of REMB packages. It follows that min values
 *          </li>
 *          <li>
 *            Output bandwidth control mechanism: Configuration interval used to
 *            <ul>
 *              <li>
 *                setMinVideoSendBandwidth: sets the minimum bitrate for video 
 *                to be sent to remote peer. 0 is considered unconstrained.
 *              </li>
 *              <li>
 *                setMaxVideoSendBandwidth: sets maximum bitrate limits for 
 *                video sent to remote peer. 0 is considered unconstrained.
 *              </li>
 *            </ul>
 *          </li>
 *        </ul>
 *        All bandwidth control parameters must be changed before the SDP 
 *        negotiation takes place, and can't be changed afterwards.
 *        </p>
 *
 * @abstract
 * @extends module:core/abstracts.SdpEndpoint
 *
 * @constructor module:core/abstracts.BaseRtpEndpoint
 *
 * @fires {@link module:core#event:ConnectionStateChanged ConnectionStateChanged}
 * @fires {@link module:core#event:MediaStateChanged MediaStateChanged}
 */
function BaseRtpEndpoint(){
  BaseRtpEndpoint.super_.call(this);
};
inherits(BaseRtpEndpoint, SdpEndpoint);


//
// Public properties
//

/**
 * Connection state. Possible values are
 *           <ul>
 *             <li>CONNECTED</li>
 *             <li>DISCONNECTED</li>
 *           </ul>
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getConnectionState
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getConnectionStateCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getConnectionState = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getConnectionState', callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getConnectionStateCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ConnectionState} result
 */

/**
 * Maximum bandwidth for video transmission, in kbps. The default value is 500 
 * kbps. 0 is considered unconstrained.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMaxVideoSendBandwidth
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMaxVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMaxVideoSendBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMaxVideoSendBandwidth', callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMaxVideoSendBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Maximum bandwidth for video transmission, in kbps. The default value is 500 
 * kbps. 0 is considered unconstrained.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#setMaxVideoSendBandwidth
 *
 * @param {external:Integer} maxVideoSendBandwidth
 * @param {module:core/abstracts.BaseRtpEndpoint~setMaxVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.setMaxVideoSendBandwidth = function(maxVideoSendBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'maxVideoSendBandwidth', maxVideoSendBandwidth, {required: true});
  //  

  var params = {
    maxVideoSendBandwidth: maxVideoSendBandwidth
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMaxVideoSendBandwidth', params, callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~setMaxVideoSendBandwidthCallback
 * @param {external:Error} error
 */

/**
 * Media flow state. Possible values are
 *           <ul>
 *             <li>CONNECTED: There is an RTCP flow.</li>
 *             <li>DISCONNECTED: No RTCP packets have been received for at least
 *           </ul>
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMediaState
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMediaStateCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMediaState = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMediaState', callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMediaStateCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.MediaState} result
 */

/**
 * Minimum bandwidth announced for video reception, in kbps. The default and 
 * absolute minimum value is 30 kbps, even if a lower value is set.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMinVideoRecvBandwidth
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMinVideoRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMinVideoRecvBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMinVideoRecvBandwidth', callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMinVideoRecvBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Minimum bandwidth announced for video reception, in kbps. The default and 
 * absolute minimum value is 30 kbps, even if a lower value is set.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#setMinVideoRecvBandwidth
 *
 * @param {external:Integer} minVideoRecvBandwidth
 * @param {module:core/abstracts.BaseRtpEndpoint~setMinVideoRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.setMinVideoRecvBandwidth = function(minVideoRecvBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'minVideoRecvBandwidth', minVideoRecvBandwidth, {required: true});
  //  

  var params = {
    minVideoRecvBandwidth: minVideoRecvBandwidth
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMinVideoRecvBandwidth', params, callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~setMinVideoRecvBandwidthCallback
 * @param {external:Error} error
 */

/**
 * Minimum bandwidth for video transmission, in kbps. The default value is 100 
 * kbps. 0 is considered unconstrained.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getMinVideoSendBandwidth
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getMinVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getMinVideoSendBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMinVideoSendBandwidth', callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getMinVideoSendBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Minimum bandwidth for video transmission, in kbps. The default value is 100 
 * kbps. 0 is considered unconstrained.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#setMinVideoSendBandwidth
 *
 * @param {external:Integer} minVideoSendBandwidth
 * @param {module:core/abstracts.BaseRtpEndpoint~setMinVideoSendBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.setMinVideoSendBandwidth = function(minVideoSendBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'minVideoSendBandwidth', minVideoSendBandwidth, {required: true});
  //  

  var params = {
    minVideoSendBandwidth: minVideoSendBandwidth
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMinVideoSendBandwidth', params, callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~setMinVideoSendBandwidthCallback
 * @param {external:Error} error
 */

/**
 * Advanced parameters to configure the congestion control algorithm.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#getRembParams
 *
 * @param {module:core/abstracts.BaseRtpEndpoint~getRembParamsCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.getRembParams = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getRembParams', callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~getRembParamsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.RembParams} result
 */

/**
 * Advanced parameters to configure the congestion control algorithm.
 *
 * @alias module:core/abstracts.BaseRtpEndpoint#setRembParams
 *
 * @param {module:core/complexTypes.RembParams} rembParams
 * @param {module:core/abstracts.BaseRtpEndpoint~setRembParamsCallback} [callback]
 *
 * @return {external:Promise}
 */
BaseRtpEndpoint.prototype.setRembParams = function(rembParams, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('RembParams', 'rembParams', rembParams, {required: true});
  //  

  var params = {
    rembParams: rembParams
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setRembParams', params, callback), this)
};
/**
 * @callback module:core/abstracts.BaseRtpEndpoint~setRembParamsCallback
 * @param {external:Error} error
 */


/**
 * @alias module:core/abstracts.BaseRtpEndpoint.constructorParams
 */
BaseRtpEndpoint.constructorParams = {
};

/**
 * @alias module:core/abstracts.BaseRtpEndpoint.events
 *
 * @extends module:core/abstracts.SdpEndpoint.events
 */
BaseRtpEndpoint.events = SdpEndpoint.events.concat(['ConnectionStateChanged', 'MediaStateChanged']);


/**
 * Checker for {@link module:core/abstracts.BaseRtpEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.BaseRtpEndpoint} value
 */
function checkBaseRtpEndpoint(key, value)
{
  if(!(value instanceof BaseRtpEndpoint))
    throw ChecktypeError(key, BaseRtpEndpoint, value);
};


module.exports = BaseRtpEndpoint;

BaseRtpEndpoint.check = checkBaseRtpEndpoint;

},{"./SdpEndpoint":36,"inherits":"inherits","kurento-client":"kurento-client"}],31:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./MediaElement');


/**
 * @classdesc
 *  Base interface for all end points. An Endpoint is a {@link 
 *  module:core/abstracts.MediaElement MediaElement}
 *  that allow <a 
 *  href="http://www.kurento.org/docs/current/glossary.html#term-kms">KMS</a> to
 *  <a href="http<a href="http://<a 
 *  href="http://www.kurento.org/docs/current/glossary.html#term-http">HTTP</a>org/docs/current/glossary.html#term-webrtc">WebRTC</a>.org/docs/current/glossary.html#term-rtp">RTP</a>different
 *  :term:`WebRTC`, :term:`HTTP`, <code>file:/</code> URLs... An 
 *  <code>Endpoint</code> may
 *  contain both sources and sinks for different media types, to provide
 *  bidirectional communication.
 *
 * @abstract
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core/abstracts.Endpoint
 */
function Endpoint(){
  Endpoint.super_.call(this);
};
inherits(Endpoint, MediaElement);


/**
 * @alias module:core/abstracts.Endpoint.constructorParams
 */
Endpoint.constructorParams = {
};

/**
 * @alias module:core/abstracts.Endpoint.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
Endpoint.events = MediaElement.events;


/**
 * Checker for {@link module:core/abstracts.Endpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.Endpoint} value
 */
function checkEndpoint(key, value)
{
  if(!(value instanceof Endpoint))
    throw ChecktypeError(key, Endpoint, value);
};


module.exports = Endpoint;

Endpoint.check = checkEndpoint;

},{"./MediaElement":34,"inherits":"inherits","kurento-client":"kurento-client"}],32:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var MediaElement = require('./MediaElement');


/**
 * @classdesc
 *  Base interface for all filters. This is a certain type of {@link 
 *  module:core/abstracts.MediaElement MediaElement}, that processes media 
 *  injected through its sinks, and delivers the outcome through its sources.
 *
 * @abstract
 * @extends module:core/abstracts.MediaElement
 *
 * @constructor module:core/abstracts.Filter
 */
function Filter(){
  Filter.super_.call(this);
};
inherits(Filter, MediaElement);


/**
 * @alias module:core/abstracts.Filter.constructorParams
 */
Filter.constructorParams = {
};

/**
 * @alias module:core/abstracts.Filter.events
 *
 * @extends module:core/abstracts.MediaElement.events
 */
Filter.events = MediaElement.events;


/**
 * Checker for {@link module:core/abstracts.Filter}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.Filter} value
 */
function checkFilter(key, value)
{
  if(!(value instanceof Filter))
    throw ChecktypeError(key, Filter, value);
};


module.exports = Filter;

Filter.check = checkFilter;

},{"./MediaElement":34,"inherits":"inherits","kurento-client":"kurento-client"}],33:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var HubPort = require('../HubPort');

var MediaObject = require('./MediaObject');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  A Hub is a routing {@link module:core/abstracts.MediaObject MediaObject}. It
 *
 * @abstract
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core/abstracts.Hub
 */
function Hub(){
  Hub.super_.call(this);
};
inherits(Hub, MediaObject);


//
// Public methods
//

/**
 * Returns a string in dot (graphviz) format that represents the gstreamer 
 * elements inside the pipeline
 *
 * @alias module:core/abstracts.Hub.getGstreamerDot
 *
 * @param {module:core/complexTypes.GstreamerDotDetails} [details]
 *  Details of graph
 *
 * @param {module:core/abstracts.Hub~getGstreamerDotCallback} [callback]
 *
 * @return {external:Promise}
 */
Hub.prototype.getGstreamerDot = function(details, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: details = undefined;
    break;
    case 1: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-1]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 1;

      throw error;
  }

  //  
  // checkType('GstreamerDotDetails', 'details', details);
  //  

  var params = {
    details: details
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getGstreamerDot', params, callback), this)
};
/**
 * @callback module:core/abstracts.Hub~getGstreamerDotCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The dot graph
 */


/**
 * Create a new instance of a {module:core~HubPort} attached to this {module:core~Hub}
 *
 * @param {module:core/abstract.Hub~createHubCallback} callback
 *
 * @return {external:Promise}
 */
Hub.prototype.createHubPort = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  var mediaObject = new HubPort()

  mediaObject.on('_rpc', this.emit.bind(this, '_rpc'));

  var params =
  {
    type: 'HubPort',
    constructorParams: {hub: this}
  };

  Object.defineProperty(params, 'object', {value: mediaObject});

  this.emit('_create', transaction, params, callback);

  return mediaObject
};
/**
 * @callback core/abstract.Hub~createHubCallback
 * @param {external:Error} error
 * @param {module:core/abstract.HubPort} result
 *  The created HubPort
 */


/**
 * @alias module:core/abstracts.Hub.constructorParams
 */
Hub.constructorParams = {
};

/**
 * @alias module:core/abstracts.Hub.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
Hub.events = MediaObject.events;


/**
 * Checker for {@link module:core/abstracts.Hub}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.Hub} value
 */
function checkHub(key, value)
{
  if(!(value instanceof Hub))
    throw ChecktypeError(key, Hub, value);
};


module.exports = Hub;

Hub.check = checkHub;

},{"../HubPort":27,"./MediaObject":35,"inherits":"inherits","kurento-client":"kurento-client"}],34:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var checkArray = checkType.checkArray;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var each = require('async').each

var promiseCallback = require('promisecallback');

var MediaObject = require('./MediaObject');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  <p>This is the basic building block of the media server, that can be 
 *  interconnected inside a pipeline. A {@link 
 *  module:core/abstracts.MediaElement MediaElement} is a module that 
 *  encapsulates a specific media capability, and that is able to exchange media
 *        </p>
 *        <p>
 *        A pad can be defined as an input or output interface. Input pads are 
 *        called sinks, and it's where the media elements receive media from 
 *        other media elements. Output interfaces are called sources, and it's 
 *        the pad used by the media element to feed media to other media 
 *        elements. There can be only one sink pad per media element. On the 
 *        other hand, the number of source pads is unconstrained. This means 
 *        that a certain media element can receive media only from one element 
 *        at a time, while it can send media to many others. Pads are created on
 *        </p>
 *        <p>
 *        When media elements are connected, it can be the case that the 
 *        encoding required in both input and output pads is not the same, and 
 *        thus it needs to be transcoded. This is something that is handled 
 *        transparently by the MediaElement internals, but such transcoding has 
 *        a toll in the form of a higher CPU load, so connecting MediaElements 
 *        that need media encoded in different formats is something to consider 
 *        as a high load operation. The event `MediaTranscodingStateChange` 
 *        allows to inform the client application of whether media transcoding 
 *        is being enabled or not inside any MediaElement object.
 *        </p>
 *
 * @abstract
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core/abstracts.MediaElement
 *
 * @fires {@link module:core#event:ElementConnected ElementConnected}
 * @fires {@link module:core#event:ElementDisconnected ElementDisconnected}
 * @fires {@link module:core#event:MediaFlowInStateChange MediaFlowInStateChange}
 * @fires {@link module:core#event:MediaFlowOutStateChange MediaFlowOutStateChange}
 * @fires {@link module:core#event:MediaTranscodingStateChange MediaTranscodingStateChange}
 */
function MediaElement(){
  MediaElement.super_.call(this);
};
inherits(MediaElement, MediaObject);


//
// Public properties
//

/**
 * @deprecated
 * Deprecated due to a typo. Use maxOutputBitrate instead of this function. 
 * Maximum video bandwidth for transcoding. 0 = unlimited.
 *   Unit: bps(bits per second).
 *   Default value: MAXINT
 *
 * @alias module:core/abstracts.MediaElement#getMaxOuputBitrate
 *
 * @param {module:core/abstracts.MediaElement~getMaxOuputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getMaxOuputBitrate = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMaxOuputBitrate', callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getMaxOuputBitrateCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * @deprecated
 * Deprecated due to a typo. Use maxOutputBitrate instead of this function. 
 * Maximum video bandwidth for transcoding. 0 = unlimited.
 *   Unit: bps(bits per second).
 *   Default value: MAXINT
 *
 * @alias module:core/abstracts.MediaElement#setMaxOuputBitrate
 *
 * @param {external:Integer} maxOuputBitrate
 * @param {module:core/abstracts.MediaElement~setMaxOuputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setMaxOuputBitrate = function(maxOuputBitrate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'maxOuputBitrate', maxOuputBitrate, {required: true});
  //  

  var params = {
    maxOuputBitrate: maxOuputBitrate
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMaxOuputBitrate', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setMaxOuputBitrateCallback
 * @param {external:Error} error
 */

/**
 * Maximum video bitrate for transcoding. 0 = unlimited.
 *   Unit: bps(bits per second).
 *   Default value: MAXINT
 *
 * @alias module:core/abstracts.MediaElement#getMaxOutputBitrate
 *
 * @param {module:core/abstracts.MediaElement~getMaxOutputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getMaxOutputBitrate = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMaxOutputBitrate', callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getMaxOutputBitrateCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Maximum video bitrate for transcoding. 0 = unlimited.
 *   Unit: bps(bits per second).
 *   Default value: MAXINT
 *
 * @alias module:core/abstracts.MediaElement#setMaxOutputBitrate
 *
 * @param {external:Integer} maxOutputBitrate
 * @param {module:core/abstracts.MediaElement~setMaxOutputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setMaxOutputBitrate = function(maxOutputBitrate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'maxOutputBitrate', maxOutputBitrate, {required: true});
  //  

  var params = {
    maxOutputBitrate: maxOutputBitrate
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMaxOutputBitrate', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setMaxOutputBitrateCallback
 * @param {external:Error} error
 */

/**
 * @deprecated
 * Deprecated due to a typo. Use minOutputBitrate instead of this function. 
 * Minimum video bandwidth for transcoding.
 *   Unit: bps(bits per second).
 *   Default value: 0
 *
 * @alias module:core/abstracts.MediaElement#getMinOuputBitrate
 *
 * @param {module:core/abstracts.MediaElement~getMinOuputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getMinOuputBitrate = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMinOuputBitrate', callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getMinOuputBitrateCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * @deprecated
 * Deprecated due to a typo. Use minOutputBitrate instead of this function. 
 * Minimum video bandwidth for transcoding.
 *   Unit: bps(bits per second).
 *   Default value: 0
 *
 * @alias module:core/abstracts.MediaElement#setMinOuputBitrate
 *
 * @param {external:Integer} minOuputBitrate
 * @param {module:core/abstracts.MediaElement~setMinOuputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setMinOuputBitrate = function(minOuputBitrate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'minOuputBitrate', minOuputBitrate, {required: true});
  //  

  var params = {
    minOuputBitrate: minOuputBitrate
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMinOuputBitrate', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setMinOuputBitrateCallback
 * @param {external:Error} error
 */

/**
 * Minimum video bitrate for transcoding.
 *   Unit: bps(bits per second).
 *   Default value: 0
 *
 * @alias module:core/abstracts.MediaElement#getMinOutputBitrate
 *
 * @param {module:core/abstracts.MediaElement~getMinOutputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getMinOutputBitrate = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMinOutputBitrate', callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getMinOutputBitrateCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * Minimum video bitrate for transcoding.
 *   Unit: bps(bits per second).
 *   Default value: 0
 *
 * @alias module:core/abstracts.MediaElement#setMinOutputBitrate
 *
 * @param {external:Integer} minOutputBitrate
 * @param {module:core/abstracts.MediaElement~setMinOutputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setMinOutputBitrate = function(minOutputBitrate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'minOutputBitrate', minOutputBitrate, {required: true});
  //  

  var params = {
    minOutputBitrate: minOutputBitrate
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMinOutputBitrate', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setMinOutputBitrateCallback
 * @param {external:Error} error
 */


//
// Public methods
//

/**
 * <p>Connects two elements, with the media flowing from left to right: the 
 * elements that invokes the connect wil be the source of media, creating one 
 * sink pad for each type of media connected. The element given as parameter to 
 * the method will be the sink, and it will create one sink pad per media type 
 * connected.
 *           </p>
 *           <p>
 *           If otherwise not specified, all types of media are connected by 
 *           default (AUDIO, VIDEO and DATA). It is recommended to connect the 
 *           specific types of media if not all of them will be used. For this 
 *           purpose, the connect method can be invoked more than once on the 
 *           same two elements, but with different media types.
 *           </p>
 *           <p>
 *           The connection is unidirectional. If a bidirectional connection is 
 *           desired, the position of the media elements must be inverted. For 
 *           instance, webrtc1.connect(webrtc2) is connecting webrtc1 as source 
 *           of webrtc2. In order to create a WebRTC one-2one conversation, the 
 *           user would need to especify the connection on the other direction 
 *           with webrtc2.connect(webrtc1).
 *           </p>
 *           <p>
 *           Even though one media element can have one sink pad per type of 
 *           media, only one media element can be connected to another at a 
 *           given time. If a media element is connected to another, the former 
 *           will become the source of the sink media element, regardles whether
 *           </p>
 *
 * @alias module:core/abstracts.MediaElement.connect
 *
 * @param {module:core/abstracts.MediaElement} sink
 *  the target {@link module:core/abstracts.MediaElement MediaElement} that will
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  the {@link MediaType} of the pads that will be connected
 *
 * @param {external:String} [sourceMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly 
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {external:String} [sinkMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly 
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~connectCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.connect = function(sink, mediaType, sourceMediaDescription, sinkMediaDescription, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var promise
  if(sink instanceof Array)
  {
    callback = arguments[arguments.length-1] instanceof Function
             ? Array.prototype.pop.call(arguments)
             : undefined;

    var media = sink
    var src = this;
    sink = media[media.length-1]

    // Check if we have enought media components
    if(!media.length)
      throw new SyntaxError('Need at least one media element to connect');

    // Check MediaElements are of the correct type
    checkArray('MediaElement', 'media', media)

    // Generate promise
    promise = new Promise(function(resolve, reject)
    {
      function callback(error, result)
      {
        if(error) return reject(error);

        resolve(result);
      };

      each(media, function(sink, callback)
      {
        src = src.connect(sink, callback);
      },
      callback);
    });

    promise = promiseCallback(promise, callback)
  }
  else
  {
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 1: mediaType = undefined;
    case 2: sourceMediaDescription = undefined;
    case 3: sinkMediaDescription = undefined;
    break;
    case 4: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [1-4]');
          error.length = arguments.length;
          error.min = 1;
          error.max = 4;

      throw error;
  }

  //  
  // checkType('MediaElement', 'sink', sink, {required: true});
  //  
  // checkType('MediaType', 'mediaType', mediaType);
  //  
  // checkType('String', 'sourceMediaDescription', sourceMediaDescription);
  //  
  // checkType('String', 'sinkMediaDescription', sinkMediaDescription);
  //  

  var params = {
    sink: sink,
    mediaType: mediaType,
    sourceMediaDescription: sourceMediaDescription,
    sinkMediaDescription: sinkMediaDescription
  };

  callback = (callback || noop).bind(this)

    promise = this._invoke(transaction, 'connect', params, callback)
  }

  return disguise(promise, sink)
};
/**
 * @callback module:core/abstracts.MediaElement~connectCallback
 * @param {external:Error} error
 */

/**
 * Disconnects two media elements. This will release the source pads of the 
 * source media element, and the sink pads of the sink media element.
 *
 * @alias module:core/abstracts.MediaElement.disconnect
 *
 * @param {module:core/abstracts.MediaElement} sink
 *  the target {@link module:core/abstracts.MediaElement MediaElement} that will
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  the {@link MediaType} of the pads that will be connected
 *
 * @param {external:String} [sourceMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly 
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {external:String} [sinkMediaDescription]
 *  A textual description of the media source. Currently not used, aimed mainly 
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~disconnectCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.disconnect = function(sink, mediaType, sourceMediaDescription, sinkMediaDescription, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 1: mediaType = undefined;
    case 2: sourceMediaDescription = undefined;
    case 3: sinkMediaDescription = undefined;
    break;
    case 4: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [1-4]');
          error.length = arguments.length;
          error.min = 1;
          error.max = 4;

      throw error;
  }

  //  
  // checkType('MediaElement', 'sink', sink, {required: true});
  //  
  // checkType('MediaType', 'mediaType', mediaType);
  //  
  // checkType('String', 'sourceMediaDescription', sourceMediaDescription);
  //  
  // checkType('String', 'sinkMediaDescription', sinkMediaDescription);
  //  

  var params = {
    sink: sink,
    mediaType: mediaType,
    sourceMediaDescription: sourceMediaDescription,
    sinkMediaDescription: sinkMediaDescription
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'disconnect', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~disconnectCallback
 * @param {external:Error} error
 */

/**
 * This method returns a .dot file describing the topology of the media element.
 *           <ul>
 *             <li>SHOW_ALL: default value</li>
 *             <li>SHOW_CAPS_DETAILS</li>
 *             <li>SHOW_FULL_PARAMS</li>
 *             <li>SHOW_MEDIA_TYPE</li>
 *             <li>SHOW_NON_DEFAULT_PARAMS</li>
 *             <li>SHOW_STATES</li>
 *             <li>SHOW_VERBOSE</li>
 *           </ul>
 *
 * @alias module:core/abstracts.MediaElement.getGstreamerDot
 *
 * @param {module:core/complexTypes.GstreamerDotDetails} [details]
 *  Details of graph
 *
 * @param {module:core/abstracts.MediaElement~getGstreamerDotCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getGstreamerDot = function(details, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: details = undefined;
    break;
    case 1: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-1]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 1;

      throw error;
  }

  //  
  // checkType('GstreamerDotDetails', 'details', details);
  //  

  var params = {
    details: details
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getGstreamerDot', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getGstreamerDotCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The dot graph
 */

/**
 * Gets information about the source pads of this media element. Since source 
 * pads connect to other media element's sinks, this is formally the sink of 
 * media from the element's perspective. Media can be filtered by type, or by 
 * the description given to the pad though which both elements are connected.
 *
 * @alias module:core/abstracts.MediaElement.getSinkConnections
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO}, {@link 
 *  module:core/abstracts.MediaElement#MediaType.VIDEO} or {@link 
 *  module:core/abstracts.MediaElement#MediaType.DATA}
 *
 * @param {external:String} [description]
 *  A textual description of the media source. Currently not used, aimed mainly 
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~getSinkConnectionsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getSinkConnections = function(mediaType, description, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: mediaType = undefined;
    case 1: description = undefined;
    break;
    case 2: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-2]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 2;

      throw error;
  }

  //  
  // checkType('MediaType', 'mediaType', mediaType);
  //  
  // checkType('String', 'description', description);
  //  

  var params = {
    mediaType: mediaType,
    description: description
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getSinkConnections', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getSinkConnectionsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ElementConnectionData} result
 *  A list of the connections information that are receiving media from this 
 *  element. The list will be empty if no sources are found.
 */

/**
 * Gets information about the sink pads of this media element. Since sink pads 
 * are the interface through which a media element gets it's media, whatever is 
 * connected to an element's sink pad is formally a source of media. Media can 
 * be filtered by type, or by the description given to the pad though which both
 *
 * @alias module:core/abstracts.MediaElement.getSourceConnections
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO}, {@link 
 *  module:core/abstracts.MediaElement#MediaType.VIDEO} or {@link 
 *  module:core/abstracts.MediaElement#MediaType.DATA}
 *
 * @param {external:String} [description]
 *  A textual description of the media source. Currently not used, aimed mainly 
 *  for {@link module:core/abstracts.MediaElement#MediaType.DATA} sources
 *
 * @param {module:core/abstracts.MediaElement~getSourceConnectionsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getSourceConnections = function(mediaType, description, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: mediaType = undefined;
    case 1: description = undefined;
    break;
    case 2: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-2]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 2;

      throw error;
  }

  //  
  // checkType('MediaType', 'mediaType', mediaType);
  //  
  // checkType('String', 'description', description);
  //  

  var params = {
    mediaType: mediaType,
    description: description
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getSourceConnections', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getSourceConnectionsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ElementConnectionData} result
 *  A list of the connections information that are sending media to this 
 *  element. The list will be empty if no sources are found.
 */

/**
 * Gets the statistics related to an endpoint. If no media type is specified, it
 *
 * @alias module:core/abstracts.MediaElement.getStats
 *
 * @param {module:core/complexTypes.MediaType} [mediaType]
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO} or {@link 
 *  module:core/abstracts.MediaElement#MediaType.VIDEO}
 *
 * @param {module:core/abstracts.MediaElement~getStatsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.getStats = function(mediaType, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: mediaType = undefined;
    break;
    case 1: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-1]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 1;

      throw error;
  }

  //  
  // checkType('MediaType', 'mediaType', mediaType);
  //  

  var params = {
    mediaType: mediaType
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getStats', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~getStatsCallback
 * @param {external:Error} error
 * @param {Object.<string, module:core/complexTypes.Stats>} result
 *  Delivers a successful result in the form of a RTC stats report. A RTC stats 
 *  report represents a map between strings, identifying the inspected objects 
 *  (RTCStats.id), and their corresponding RTCStats objects.
 */

/**
 * This method indicates whether the media element is receiving media of a 
 * certain type. The media sink pad can be identified individually, if needed. 
 * It is only supported for AUDIO and VIDEO types, raising a 
 * MEDIA_OBJECT_ILLEGAL_PARAM_ERROR otherwise. If the pad indicated does not 
 * exist, if will return false.
 *
 * @alias module:core/abstracts.MediaElement.isMediaFlowingIn
 *
 * @param {module:core/complexTypes.MediaType} mediaType
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO} or {@link 
 *  module:core/abstracts.MediaElement#MediaType.VIDEO}
 *
 * @param {external:String} [sinkMediaDescription]
 *  Description of the sink
 *
 * @param {module:core/abstracts.MediaElement~isMediaFlowingInCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.isMediaFlowingIn = function(mediaType, sinkMediaDescription, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 1: sinkMediaDescription = undefined;
    break;
    case 2: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [1-2]');
          error.length = arguments.length;
          error.min = 1;
          error.max = 2;

      throw error;
  }

  //  
  // checkType('MediaType', 'mediaType', mediaType, {required: true});
  //  
  // checkType('String', 'sinkMediaDescription', sinkMediaDescription);
  //  

  var params = {
    mediaType: mediaType,
    sinkMediaDescription: sinkMediaDescription
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'isMediaFlowingIn', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~isMediaFlowingInCallback
 * @param {external:Error} error
 * @param {external:Boolean} result
 *  TRUE if there is media, FALSE in other case
 */

/**
 * This method indicates whether the media element is emitting media of a 
 * certain type. The media source pad can be identified individually, if needed.
 *
 * @alias module:core/abstracts.MediaElement.isMediaFlowingOut
 *
 * @param {module:core/complexTypes.MediaType} mediaType
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO} or {@link 
 *  module:core/abstracts.MediaElement#MediaType.VIDEO}
 *
 * @param {external:String} [sourceMediaDescription]
 *  Description of the source
 *
 * @param {module:core/abstracts.MediaElement~isMediaFlowingOutCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.isMediaFlowingOut = function(mediaType, sourceMediaDescription, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 1: sourceMediaDescription = undefined;
    break;
    case 2: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [1-2]');
          error.length = arguments.length;
          error.min = 1;
          error.max = 2;

      throw error;
  }

  //  
  // checkType('MediaType', 'mediaType', mediaType, {required: true});
  //  
  // checkType('String', 'sourceMediaDescription', sourceMediaDescription);
  //  

  var params = {
    mediaType: mediaType,
    sourceMediaDescription: sourceMediaDescription
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'isMediaFlowingOut', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~isMediaFlowingOutCallback
 * @param {external:Error} error
 * @param {external:Boolean} result
 *  TRUE if there is media, FALSE in other case
 */

/**
 * Indicates whether this media element is actively transcoding between input 
 * and output pads. This operation is only supported for AUDIO and VIDEO media 
 * types, raising a MEDIA_OBJECT_ILLEGAL_PARAM_ERROR otherwise.
 *           The internal GStreamer processing bin can be indicated, if needed; 
 *           if the bin doesn't exist, the return value will be FALSE.
 *
 * @alias module:core/abstracts.MediaElement.isMediaTranscoding
 *
 * @param {module:core/complexTypes.MediaType} mediaType
 *  One of {@link module:core/abstracts.MediaElement#MediaType.AUDIO} or {@link 
 *  module:core/abstracts.MediaElement#MediaType.VIDEO}
 *
 * @param {external:String} [binName]
 *  Internal name of the processing bin, as previously given by 
 *  <code>MediaTranscodingStateChange</code>.
 *
 * @param {module:core/abstracts.MediaElement~isMediaTranscodingCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.isMediaTranscoding = function(mediaType, binName, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 1: binName = undefined;
    break;
    case 2: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [1-2]');
          error.length = arguments.length;
          error.min = 1;
          error.max = 2;

      throw error;
  }

  //  
  // checkType('MediaType', 'mediaType', mediaType, {required: true});
  //  
  // checkType('String', 'binName', binName);
  //  

  var params = {
    mediaType: mediaType,
    binName: binName
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'isMediaTranscoding', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~isMediaTranscodingCallback
 * @param {external:Error} error
 * @param {external:Boolean} result
 *  TRUE if media is being transcoded, FALSE otherwise.
 */

/**
 * Sets the type of data for the audio stream. MediaElements that do not support
 *
 * @alias module:core/abstracts.MediaElement.setAudioFormat
 *
 * @param {module:core/complexTypes.AudioCaps} caps
 *  The format for the stream of audio
 *
 * @param {module:core/abstracts.MediaElement~setAudioFormatCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setAudioFormat = function(caps, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('AudioCaps', 'caps', caps, {required: true});
  //  

  var params = {
    caps: caps
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setAudioFormat', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setAudioFormatCallback
 * @param {external:Error} error
 */

/**
 * @deprecated
 * Allows change the target bitrate for the media output, if the media is 
 * encoded using VP8 or H264. This method only works if it is called before the 
 * media starts to flow.
 *
 * @alias module:core/abstracts.MediaElement.setOutputBitrate
 *
 * @param {external:Integer} bitrate
 *  Configure the enconding media bitrate in bps
 *
 * @param {module:core/abstracts.MediaElement~setOutputBitrateCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setOutputBitrate = function(bitrate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'bitrate', bitrate, {required: true});
  //  

  var params = {
    bitrate: bitrate
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setOutputBitrate', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setOutputBitrateCallback
 * @param {external:Error} error
 */

/**
 * Sets the type of data for the video stream. MediaElements that do not support
 *
 * @alias module:core/abstracts.MediaElement.setVideoFormat
 *
 * @param {module:core/complexTypes.VideoCaps} caps
 *  The format for the stream of video
 *
 * @param {module:core/abstracts.MediaElement~setVideoFormatCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaElement.prototype.setVideoFormat = function(caps, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('VideoCaps', 'caps', caps, {required: true});
  //  

  var params = {
    caps: caps
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setVideoFormat', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaElement~setVideoFormatCallback
 * @param {external:Error} error
 */


/**
 * @alias module:core/abstracts.MediaElement.constructorParams
 */
MediaElement.constructorParams = {
};

/**
 * @alias module:core/abstracts.MediaElement.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
MediaElement.events = MediaObject.events.concat(['ElementConnected', 'ElementDisconnected', 'MediaFlowInStateChange', 'MediaFlowOutStateChange', 'MediaTranscodingStateChange']);


/**
 * Checker for {@link module:core/abstracts.MediaElement}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.MediaElement} value
 */
function checkMediaElement(key, value)
{
  if(!(value instanceof MediaElement))
    throw ChecktypeError(key, MediaElement, value);
};


module.exports = MediaElement;

MediaElement.check = checkMediaElement;

},{"./MediaObject":35,"async":"async","inherits":"inherits","kurento-client":"kurento-client","promisecallback":"promisecallback"}],35:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var promiseCallback = require('promisecallback');

var EventEmitter = require('events').EventEmitter;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  <p>Base interface used to manage capabilities common to all Kurento 
 *  elements. This includes both: {@link module:core/abstracts.MediaElement 
 *  MediaElement} and {@link module:core.MediaPipeline MediaPipeline}</p>
 *        <h4>Properties</h4>
 *        <ul>
 *          <li><b>id</b>: unique identifier assigned to this 
 *          <code>MediaObject</code> at instantiation time. {@link 
 *          module:core.MediaPipeline MediaPipeline} IDs are generated with a 
 *          GUID followed by suffix <code>_kurento.MediaPipeline</code>. {@link 
 *          module:core/abstracts.MediaElement MediaElement} IDs are also a GUID
 *            <blockquote>
 *            <dl>
 *              <dt><i>MediaPipeline ID example</i></dt>
 *              <dd><code>907cac3a-809a-4bbe-a93e-ae7e944c5cae_kurento.MediaPipeline</code></dd>
 *              <dt><i>MediaElement ID example</i></dt> 
 *              <dd><code>907cac3a-809a-4bbe-a93e-ae7e944c5cae_kurento.MediaPipeline/403da25a-805b-4cf1-8c55-f190588e6c9b_kurento.WebRtcEndpoint</code></dd>
 *            </dl>
 *            </blockquote>
 *          </li>
 *          <li><b>name</b>: free text intended to provide a friendly name for 
 *          this <code>MediaObject</code>. Its default value is the same as the 
 *          ID.</li>
 *          <li><b>tags</b>: key-value pairs intended for applications to 
 *          associate metadata to this <code>MediaObject</code> instance.</li>
 *        </ul>
 *        <p>
 *        <h4>Events</h4>
 *        <ul>
 *          <li>`ErrorEvent`: reports asynchronous error events. It is 
 *          recommended to always subscribe a listener to this event, as regular
 *        </ul>
 *
 * @abstract
 * @extends external:EventEmitter
 *
 * @constructor module:core/abstracts.MediaObject
 *
 * @fires {@link module:core#event:Error Error}
 */
function MediaObject(){
  MediaObject.super_.call(this);


  var self = this;


  //
  // Define object properties
  //

  /**
   * Unique identifier of this object
   *
   * @public
   * @readonly
   * @member {external:Number} id
   */
  this.once('_id', function(error, id)
  {
    if(error)
      return Object.defineProperties(this,
      {
        '_createError': {value: error},
        'id': {value: null, enumerable: true}
      });

    Object.defineProperty(this, 'id',
    {
      configurable: true,
      enumerable: true,
      value: id
    });
  })

  //
  // Subscribe and unsubscribe events on the server when adding and removing
  // event listeners on this MediaObject
  //

  var subscriptions = {};

  this.on('removeListener', function(event, listener)
  {
    // Blacklisted events
    if(event[0] == '_'
    || event == 'release'
    || event == 'newListener')
      return;

    var count = EventEmitter.listenerCount(this, event);
    if(count) return;

    var token = subscriptions[event];

    var params =
    {
      object: this,
      subscription: token.value,
      sessionId: token.sessionId
    };

    this.emit('_rpc', undefined, 'unsubscribe', params, function(error)
    {
      if(error) return self.emit('error', error);

      delete subscriptions[event];
    });
  });

  this.on('newListener', function(event, listener)
  {
    // Blacklisted events
    if(event[0] == '_'
    || event == 'release')
      return;

    var constructor = this.constructor;

    if(constructor.events.indexOf(event) < 0)
      throw new SyntaxError(constructor.name+" doesn't accept events of type '"+event+"'")

    var count = EventEmitter.listenerCount(this, event);
    if(count) return;

    var params =
    {
      object: this,
      type: event
    };

    this.emit('_rpc', undefined, 'subscribe', params, function(error, token)
    {
      if(error) return self.emit('error', error);

      subscriptions[event] = token;
    });
  });
};
inherits(MediaObject, EventEmitter);


//
// Public properties
//

/**
 * children of this <code>MediaObject</code>.
 *
 * @alias module:core/abstracts.MediaObject#getChildren
 *
 * @param {module:core/abstracts.MediaObject~getChildrenCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getChildren = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  if (usePromise) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {

      function callback2(error, values) {
        resolve(values)
      }

     self._invoke(transaction, 'getChildren', function(error, result) {
        if (error) return callback(error);

        self.emit('_describe', result, callback2);
      })
    });
    return promise;
  } else {
    return disguise(this._invoke(transaction, 'getChildren', function(error, result) {
      if (error) return callback(error);

      this.emit('_describe', result, callback);
    }), this)
  }
};
/**
 * @callback module:core/abstracts.MediaObject~getChildrenCallback
 * @param {external:Error} error
 * @param {module:core/abstracts.MediaObject} result
 */

/**
 * @deprecated
 *  (Use children instead) children of this <code>MediaObject</code>.
 *
 * @alias module:core/abstracts.MediaObject#getChilds
 *
 * @param {module:core/abstracts.MediaObject~getChildsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getChilds = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  if (usePromise) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {

      function callback2(error, values) {
        resolve(values)
      }

     self._invoke(transaction, 'getChilds', function(error, result) {
        if (error) return callback(error);

        self.emit('_describe', result, callback2);
      })
    });
    return promise;
  } else {
    return disguise(this._invoke(transaction, 'getChilds', function(error, result) {
      if (error) return callback(error);

      this.emit('_describe', result, callback);
    }), this)
  }
};
/**
 * @callback module:core/abstracts.MediaObject~getChildsCallback
 * @param {external:Error} error
 * @param {module:core/abstracts.MediaObject} result
 */

/**
 * <code>MediaObject</code> creation time in seconds since Epoch.
 *
 * @alias module:core/abstracts.MediaObject#getCreationTime
 *
 * @param {module:core/abstracts.MediaObject~getCreationTimeCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getCreationTime = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getCreationTime', callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~getCreationTimeCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * {@link module:core.MediaPipeline MediaPipeline} to which this 
 * <code>MediaObject</code> belongs. It returns itself when invoked for a 
 * pipeline object.
 *
 * @alias module:core/abstracts.MediaObject#getMediaPipeline
 *
 * @param {module:core/abstracts.MediaObject~getMediaPipelineCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getMediaPipeline = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  if (usePromise) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {

      function callback2(error, values) {
        resolve(values)
      }

     self._invoke(transaction, 'getMediaPipeline', function(error, result) {
        if (error) return callback(error);

        self.emit('_describe', result, callback2);
      })
    });
    return promise;
  } else {
    return disguise(this._invoke(transaction, 'getMediaPipeline', function(error, result) {
      if (error) return callback(error);

      this.emit('_describe', result, callback);
    }), this)
  }
};
/**
 * @callback module:core/abstracts.MediaObject~getMediaPipelineCallback
 * @param {external:Error} error
 * @param {module:core.MediaPipeline} result
 */

/**
 * this <code>MediaObject</code>'s name. This is just a comodity to simplify 
 * developers' life debugging, it is not used internally for indexing nor 
 * idenfiying the objects. By default, it's the object's ID.
 *
 * @alias module:core/abstracts.MediaObject#getName
 *
 * @param {module:core/abstracts.MediaObject~getNameCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getName = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getName', callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~getNameCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * this <code>MediaObject</code>'s name. This is just a comodity to simplify 
 * developers' life debugging, it is not used internally for indexing nor 
 * idenfiying the objects. By default, it's the object's ID.
 *
 * @alias module:core/abstracts.MediaObject#setName
 *
 * @param {external:String} name
 * @param {module:core/abstracts.MediaObject~setNameCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.setName = function(name, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'name', name, {required: true});
  //  

  var params = {
    name: name
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setName', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~setNameCallback
 * @param {external:Error} error
 */

/**
 * parent of this <code>MediaObject</code>. The parent of a {@link 
 * module:core/abstracts.Hub Hub} or a {@link module:core/abstracts.MediaElement
 *
 * @alias module:core/abstracts.MediaObject#getParent
 *
 * @param {module:core/abstracts.MediaObject~getParentCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getParent = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  if (usePromise) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {

      function callback2(error, values) {
        resolve(values)
      }

     self._invoke(transaction, 'getParent', function(error, result) {
        if (error) return callback(error);

        self.emit('_describe', result, callback2);
      })
    });
    return promise;
  } else {
    return disguise(this._invoke(transaction, 'getParent', function(error, result) {
      if (error) return callback(error);

      this.emit('_describe', result, callback);
    }), this)
  }
};
/**
 * @callback module:core/abstracts.MediaObject~getParentCallback
 * @param {external:Error} error
 * @param {module:core/abstracts.MediaObject} result
 */

/**
 * flag activating or deactivating sending the element's tags in fired events.
 *
 * @alias module:core/abstracts.MediaObject#getSendTagsInEvents
 *
 * @param {module:core/abstracts.MediaObject~getSendTagsInEventsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getSendTagsInEvents = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getSendTagsInEvents', callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~getSendTagsInEventsCallback
 * @param {external:Error} error
 * @param {external:Boolean} result
 */

/**
 * flag activating or deactivating sending the element's tags in fired events.
 *
 * @alias module:core/abstracts.MediaObject#setSendTagsInEvents
 *
 * @param {external:Boolean} sendTagsInEvents
 * @param {module:core/abstracts.MediaObject~setSendTagsInEventsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.setSendTagsInEvents = function(sendTagsInEvents, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('boolean', 'sendTagsInEvents', sendTagsInEvents, {required: true});
  //  

  var params = {
    sendTagsInEvents: sendTagsInEvents
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setSendTagsInEvents', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~setSendTagsInEventsCallback
 * @param {external:Error} error
 */


//
// Public methods
//

/**
 * Adds a new tag to this <code>MediaObject</code>. If the tag is already 
 * present, it changes the value.
 *
 * @alias module:core/abstracts.MediaObject.addTag
 *
 * @param {external:String} key
 *  Tag name.
 *
 * @param {external:String} value
 *  Value associated to this tag.
 *
 * @param {module:core/abstracts.MediaObject~addTagCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.addTag = function(key, value, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'key', key, {required: true});
  //  
  // checkType('String', 'value', value, {required: true});
  //  

  var params = {
    key: key,
    value: value
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'addTag', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~addTagCallback
 * @param {external:Error} error
 */

/**
 * Returns the value of given tag, or MEDIA_OBJECT_TAG_KEY_NOT_FOUND if tag is 
 * not defined.
 *
 * @alias module:core/abstracts.MediaObject.getTag
 *
 * @param {external:String} key
 *  Tag key.
 *
 * @param {module:core/abstracts.MediaObject~getTagCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getTag = function(key, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'key', key, {required: true});
  //  

  var params = {
    key: key
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getTag', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~getTagCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The value associated to the given key.
 */

/**
 * Returns all tags attached to this <code>MediaObject</code>.
 *
 * @alias module:core/abstracts.MediaObject.getTags
 *
 * @param {module:core/abstracts.MediaObject~getTagsCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.getTags = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getTags', callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~getTagsCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.Tag} result
 *  An array containing all key-value pairs associated with this 
 *  <code>MediaObject</code>.
 */

/**
 * Removes an existing tag. Exists silently with no error if tag is not defined.
 *
 * @alias module:core/abstracts.MediaObject.removeTag
 *
 * @param {external:String} key
 *  Tag name to be removed
 *
 * @param {module:core/abstracts.MediaObject~removeTagCallback} [callback]
 *
 * @return {external:Promise}
 */
MediaObject.prototype.removeTag = function(key, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'key', key, {required: true});
  //  

  var params = {
    key: key
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'removeTag', params, callback), this)
};
/**
 * @callback module:core/abstracts.MediaObject~removeTagCallback
 * @param {external:Error} error
 */


function throwRpcNotReady()
{
  throw new SyntaxError('RPC result is not ready, use .then() method instead');
};

/**
 * Send a command to a media object
 *
 * @param {external:String} method - Command to be executed by the server
 * @param {module:core/abstract.MediaObject.constructorParams} [params]
 * @param {module:core/abstract.MediaObject~invokeCallback} callback
 *
 * @return {external:Promise}
 */
Object.defineProperty(MediaObject.prototype, '_invoke',
{
  enumerable: true,
  value: function(transaction, method, params, callback){
    var self = this;

    // Fix optional parameters
    if(params instanceof Function)
    {
      if(callback)
        throw new SyntaxError("Nothing can be defined after the callback");

      callback = params;
      params = undefined;
    };

    var promise;
    var error = this._createError;
    if(error)
      promise = Promise.reject(error)
    else
    {
      promise = new Promise(function(resolve, reject)
      {
        // Generate request parameters
        var params2 =
        {
          object: self,
          operation: method
        };

        if(params)
          params2.operationParams = params;

        function callback(error, result)
        {
          if(error) return reject(error);

          var value = result.value;
          if(value === undefined)
            value = self

          resolve(value);
        }

        // Do request
        self.emit('_rpc', transaction, 'invoke', params2, callback);
      });
    }

    return promiseCallback(promise, callback, this)
  }
})
/**
 * @callback core/abstract.MediaObject~invokeCallback
 * @param {external:Error} error
 */

/**
 * Explicity release a {@link module:core/abstract.MediaObject MediaObject} from memory
 *
 * All its descendants will be also released and collected
 *
 * @param {module:core/abstract.MediaObject~releaseCallback} callback
 *
 * @return {external:Promise}
 */
MediaObject.prototype.release = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  var self = this;

  var promise;
  var error = this._createError;
  if(error)
    promise = Promise.reject(error)
  else
    promise = new Promise(function(resolve, reject)
    {
      var params =
      {
        object: self
      };

      function callback(error)
      {
        if(error) return reject(error);

        // Object was sucessfully released on the server,
        // remove it from cache and all its events
        Object.keys(self._events).forEach(function(event)
        {
          if(event[0] == '_'
          || event == 'newListener'
          || event == 'removeListener')
            return;

          self.removeAllListeners(event);
        })
        self.emit('release');

        resolve();
      }

      self.emit('_rpc', transaction, 'release', params, callback);
    });

  return disguise(promiseCallback(promise, callback), this)
};
/**
 * @callback core/abstract.MediaObject~releaseCallback
 * @param {external:Error} error
 */


// Promise interface ("thenable")

MediaObject.prototype.then = function(onFulfilled, onRejected){
  if(this.id != null)
    var promise = Promise.resolve(disguise.unthenable(this))
  else if(this.id === null)
    var promise = Promise.reject()
  else {
    var self = this

    var promise = new Promise(function(resolve, reject) {
      return self.once('_id', function(error, id) {
        if(error) return reject(error);

        resolve(disguise.unthenable(self));
      })
    })
  }

  promise = promise.then(onFulfilled ? onFulfilled.bind(this) :
function(result){return Promise.resolve(result)},
                         onRejected  ? onRejected .bind(this) :
function(error) {return Promise.reject(error)});

  return disguise(promise, this);
}

MediaObject.prototype.catch = function(onRejected)
{
  this.then(null, onRejected);
}

Object.defineProperty(MediaObject.prototype, 'commited',
{
  get: function(){return this.id !== undefined;}
});


/**
 * @alias module:core/abstracts.MediaObject.constructorParams
 */
MediaObject.constructorParams = {
};

/**
 * @alias module:core/abstracts.MediaObject.events
 */
MediaObject.events = ['Error'];


/**
 * Checker for {@link module:core/abstracts.MediaObject}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.MediaObject} value
 */
function checkMediaObject(key, value)
{
  if(!(value instanceof MediaObject))
    throw ChecktypeError(key, MediaObject, value);
};


module.exports = MediaObject;

MediaObject.check = checkMediaObject;

},{"events":21,"inherits":"inherits","kurento-client":"kurento-client","promisecallback":"promisecallback"}],36:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var SessionEndpoint = require('./SessionEndpoint');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  This interface is implemented by Endpoints that require an SDP negotiation 
 *  for the setup of a networked media session with remote peers. The API 
 *  provides the following functionality:
 *        <ul>
 *          <li>Generate SDP offers.</li>
 *          <li>Process SDP offers.</li>
 *          <li>Configure SDP related params.</li>
 *        </ul>
 *
 * @abstract
 * @extends module:core/abstracts.SessionEndpoint
 *
 * @constructor module:core/abstracts.SdpEndpoint
 */
function SdpEndpoint(){
  SdpEndpoint.super_.call(this);
};
inherits(SdpEndpoint, SessionEndpoint);


//
// Public properties
//

/**
 *  Maximum bandwidth for audio reception, in kbps. The default value is 500. A 
 *  value of 0 sets this as leaves this unconstrained. <hr/><b>Note</b> This has
 *
 * @alias module:core/abstracts.SdpEndpoint#getMaxAudioRecvBandwidth
 *
 * @param {module:core/abstracts.SdpEndpoint~getMaxAudioRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getMaxAudioRecvBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMaxAudioRecvBandwidth', callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getMaxAudioRecvBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 *  Maximum bandwidth for audio reception, in kbps. The default value is 500. A 
 *  value of 0 sets this as leaves this unconstrained. <hr/><b>Note</b> This has
 *
 * @alias module:core/abstracts.SdpEndpoint#setMaxAudioRecvBandwidth
 *
 * @param {external:Integer} maxAudioRecvBandwidth
 * @param {module:core/abstracts.SdpEndpoint~setMaxAudioRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.setMaxAudioRecvBandwidth = function(maxAudioRecvBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'maxAudioRecvBandwidth', maxAudioRecvBandwidth, {required: true});
  //  

  var params = {
    maxAudioRecvBandwidth: maxAudioRecvBandwidth
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMaxAudioRecvBandwidth', params, callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~setMaxAudioRecvBandwidthCallback
 * @param {external:Error} error
 */

/**
 *  Maximum bandwidth for video reception, in kbps. The default value is 500. A 
 *  value of 0 sets this as unconstrained. <hr/><b>Note</b> This has to be set 
 *  before the SDP is generated.
 *
 * @alias module:core/abstracts.SdpEndpoint#getMaxVideoRecvBandwidth
 *
 * @param {module:core/abstracts.SdpEndpoint~getMaxVideoRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getMaxVideoRecvBandwidth = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMaxVideoRecvBandwidth', callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getMaxVideoRecvBandwidthCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 *  Maximum bandwidth for video reception, in kbps. The default value is 500. A 
 *  value of 0 sets this as unconstrained. <hr/><b>Note</b> This has to be set 
 *  before the SDP is generated.
 *
 * @alias module:core/abstracts.SdpEndpoint#setMaxVideoRecvBandwidth
 *
 * @param {external:Integer} maxVideoRecvBandwidth
 * @param {module:core/abstracts.SdpEndpoint~setMaxVideoRecvBandwidthCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.setMaxVideoRecvBandwidth = function(maxVideoRecvBandwidth, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('int', 'maxVideoRecvBandwidth', maxVideoRecvBandwidth, {required: true});
  //  

  var params = {
    maxVideoRecvBandwidth: maxVideoRecvBandwidth
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMaxVideoRecvBandwidth', params, callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~setMaxVideoRecvBandwidthCallback
 * @param {external:Error} error
 */


//
// Public methods
//

/**
 *  Generates an SDP offer with  media capabilities of the Endpoint.
 *           Exceptions
 *           <ul>
 *             <li>
 *               SDP_END_POINT_ALREADY_NEGOTIATED If the endpoint is already 
 *               negotiated.
 *             </li>
 *             <li>
 *               SDP_END_POINT_GENERATE_OFFER_ERROR if the generated offer is 
 *               empty. This is most likely due to an internal error.
 *             </li>
 *           </ul>
 *
 * @alias module:core/abstracts.SdpEndpoint.generateOffer
 *
 * @param {module:core/abstracts.SdpEndpoint~generateOfferCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.generateOffer = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'generateOffer', callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~generateOfferCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The SDP offer.
 */

/**
 * This method returns the local SDP. The output depends on the negotiation 
 * stage:
 *           <ul>
 *             <li>
 *               No offer has been generated: returns null.
 *             </li>
 *             <li>
 *               Offer has been generated: return the SDP offer.
 *             </li>
 *             <li>
 *               Offer has been generated and answer processed: retruns the 
 *               agreed SDP.
 *             </li>
 *           </ul>
 *
 * @alias module:core/abstracts.SdpEndpoint.getLocalSessionDescriptor
 *
 * @param {module:core/abstracts.SdpEndpoint~getLocalSessionDescriptorCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getLocalSessionDescriptor = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getLocalSessionDescriptor', callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getLocalSessionDescriptorCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The last agreed SessionSpec
 */

/**
 * This method returns the remote SDP. If the negotiation process is not 
 * complete, it will return NULL.
 *
 * @alias module:core/abstracts.SdpEndpoint.getRemoteSessionDescriptor
 *
 * @param {module:core/abstracts.SdpEndpoint~getRemoteSessionDescriptorCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.getRemoteSessionDescriptor = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getRemoteSessionDescriptor', callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~getRemoteSessionDescriptorCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The last agreed User Agent session description
 */

/**
 *  Generates an SDP offer with  media capabilities of the Endpoint.
 *           Exceptions
 *           <ul>
 *             <li>
 *               SDP_PARSE_ERROR If the offer is empty or has errors.
 *             </li>
 *             <li>
 *               SDP_END_POINT_ALREADY_NEGOTIATED If the endpoint is already 
 *               negotiated.
 *             </li>
 *             <li>
 *               SDP_END_POINT_PROCESS_ANSWER_ERROR if the result of processing 
 *               the answer is an empty string. This is most likely due to an 
 *               internal error.
 *             </li>
 *             <li>
 *               SDP_END_POINT_NOT_OFFER_GENERATED If the method is invoked 
 *               before the generateOffer method.
 *             </li>
 *           </ul>
 *
 * @alias module:core/abstracts.SdpEndpoint.processAnswer
 *
 * @param {external:String} answer
 *  SessionSpec answer from the remote User Agent
 *
 * @param {module:core/abstracts.SdpEndpoint~processAnswerCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.processAnswer = function(answer, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'answer', answer, {required: true});
  //  

  var params = {
    answer: answer
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'processAnswer', params, callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~processAnswerCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  Updated SDP offer, based on the answer received.
 */

/**
 *  Processes SDP offer of the remote peer, and generates an SDP answer based on
 *           Exceptions
 *           <ul>
 *             <li>
 *               SDP_PARSE_ERROR If the offer is empty or has errors.
 *             </li>
 *             <li>
 *               SDP_END_POINT_ALREADY_NEGOTIATED If the endpoint is already 
 *               negotiated.
 *             </li>
 *             <li>
 *               SDP_END_POINT_PROCESS_OFFER_ERROR if the generated offer is 
 *               empty. This is most likely due to an internal error.
 *             </li>
 *           </ul>
 *
 * @alias module:core/abstracts.SdpEndpoint.processOffer
 *
 * @param {external:String} offer
 *  SessionSpec offer from the remote User Agent
 *
 * @param {module:core/abstracts.SdpEndpoint~processOfferCallback} [callback]
 *
 * @return {external:Promise}
 */
SdpEndpoint.prototype.processOffer = function(offer, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'offer', offer, {required: true});
  //  

  var params = {
    offer: offer
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'processOffer', params, callback), this)
};
/**
 * @callback module:core/abstracts.SdpEndpoint~processOfferCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The chosen configuration from the ones stated in the SDP offer
 */


/**
 * @alias module:core/abstracts.SdpEndpoint.constructorParams
 */
SdpEndpoint.constructorParams = {
};

/**
 * @alias module:core/abstracts.SdpEndpoint.events
 *
 * @extends module:core/abstracts.SessionEndpoint.events
 */
SdpEndpoint.events = SessionEndpoint.events;


/**
 * Checker for {@link module:core/abstracts.SdpEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.SdpEndpoint} value
 */
function checkSdpEndpoint(key, value)
{
  if(!(value instanceof SdpEndpoint))
    throw ChecktypeError(key, SdpEndpoint, value);
};


module.exports = SdpEndpoint;

SdpEndpoint.check = checkSdpEndpoint;

},{"./SessionEndpoint":38,"inherits":"inherits","kurento-client":"kurento-client"}],37:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var MediaObject = require('./MediaObject');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  This is a standalone object for managing the MediaServer
 *
 * @abstract
 * @extends module:core/abstracts.MediaObject
 *
 * @constructor module:core/abstracts.ServerManager
 *
 * @fires {@link module:core#event:ObjectCreated ObjectCreated}
 * @fires {@link module:core#event:ObjectDestroyed ObjectDestroyed}
 */
function ServerManager(){
  ServerManager.super_.call(this);
};
inherits(ServerManager, MediaObject);


//
// Public properties
//

/**
 * Server information, version, modules, factories, etc
 *
 * @alias module:core/abstracts.ServerManager#getInfo
 *
 * @param {module:core/abstracts.ServerManager~getInfoCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getInfo = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getInfo', callback), this)
};
/**
 * @callback module:core/abstracts.ServerManager~getInfoCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.ServerInfo} result
 */

/**
 * Metadata stored in the server
 *
 * @alias module:core/abstracts.ServerManager#getMetadata
 *
 * @param {module:core/abstracts.ServerManager~getMetadataCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getMetadata = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getMetadata', callback), this)
};
/**
 * @callback module:core/abstracts.ServerManager~getMetadataCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * All the pipelines available in the server
 *
 * @alias module:core/abstracts.ServerManager#getPipelines
 *
 * @param {module:core/abstracts.ServerManager~getPipelinesCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getPipelines = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  if (usePromise) {
    var self = this;

    var promise = new Promise(function(resolve, reject) {

      function callback2(error, values) {
        resolve(values)
      }

     self._invoke(transaction, 'getPipelines', function(error, result) {
        if (error) return callback(error);

        self.emit('_describe', result, callback2);
      })
    });
    return promise;
  } else {
    return disguise(this._invoke(transaction, 'getPipelines', function(error, result) {
      if (error) return callback(error);

      this.emit('_describe', result, callback);
    }), this)
  }
};
/**
 * @callback module:core/abstracts.ServerManager~getPipelinesCallback
 * @param {external:Error} error
 * @param {module:core.MediaPipeline} result
 */

/**
 * All active sessions in the server
 *
 * @alias module:core/abstracts.ServerManager#getSessions
 *
 * @param {module:core/abstracts.ServerManager~getSessionsCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getSessions = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getSessions', callback), this)
};
/**
 * @callback module:core/abstracts.ServerManager~getSessionsCallback
 * @param {external:Error} error
 * @param {external:String} result
 */


//
// Public methods
//

/**
 * Returns the kmd associated to a module
 *
 * @alias module:core/abstracts.ServerManager.getKmd
 *
 * @param {external:String} moduleName
 *  Name of the module to get its kmd file
 *
 * @param {module:core/abstracts.ServerManager~getKmdCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getKmd = function(moduleName, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  //  
  // checkType('String', 'moduleName', moduleName, {required: true});
  //  

  var params = {
    moduleName: moduleName
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getKmd', params, callback), this)
};
/**
 * @callback module:core/abstracts.ServerManager~getKmdCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The kmd file
 */

/**
 * Returns the amount of memory that the server is using in KiB
 *
 * @alias module:core/abstracts.ServerManager.getUsedMemory
 *
 * @param {module:core/abstracts.ServerManager~getUsedMemoryCallback} [callback]
 *
 * @return {external:Promise}
 */
ServerManager.prototype.getUsedMemory = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getUsedMemory', callback), this)
};
/**
 * @callback module:core/abstracts.ServerManager~getUsedMemoryCallback
 * @param {external:Error} error
 * @param {external:int64} result
 *  The amount of KiB of memory being used
 */


/**
 * @alias module:core/abstracts.ServerManager.constructorParams
 */
ServerManager.constructorParams = {
};

/**
 * @alias module:core/abstracts.ServerManager.events
 *
 * @extends module:core/abstracts.MediaObject.events
 */
ServerManager.events = MediaObject.events.concat(['ObjectCreated', 'ObjectDestroyed']);


/**
 * Checker for {@link module:core/abstracts.ServerManager}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.ServerManager} value
 */
function checkServerManager(key, value)
{
  if(!(value instanceof ServerManager))
    throw ChecktypeError(key, ServerManager, value);
};


module.exports = ServerManager;

ServerManager.check = checkServerManager;

},{"./MediaObject":35,"inherits":"inherits","kurento-client":"kurento-client"}],38:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Endpoint = require('./Endpoint');


/**
 * @classdesc
 *  All networked Endpoints that require to manage connection sessions with 
 *  remote peers implement this interface.
 *
 * @abstract
 * @extends module:core/abstracts.Endpoint
 *
 * @constructor module:core/abstracts.SessionEndpoint
 *
 * @fires {@link module:core#event:MediaSessionStarted MediaSessionStarted}
 * @fires {@link module:core#event:MediaSessionTerminated MediaSessionTerminated}
 */
function SessionEndpoint(){
  SessionEndpoint.super_.call(this);
};
inherits(SessionEndpoint, Endpoint);


/**
 * @alias module:core/abstracts.SessionEndpoint.constructorParams
 */
SessionEndpoint.constructorParams = {
};

/**
 * @alias module:core/abstracts.SessionEndpoint.events
 *
 * @extends module:core/abstracts.Endpoint.events
 */
SessionEndpoint.events = Endpoint.events.concat(['MediaSessionStarted', 'MediaSessionTerminated']);


/**
 * Checker for {@link module:core/abstracts.SessionEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.SessionEndpoint} value
 */
function checkSessionEndpoint(key, value)
{
  if(!(value instanceof SessionEndpoint))
    throw ChecktypeError(key, SessionEndpoint, value);
};


module.exports = SessionEndpoint;

SessionEndpoint.check = checkSessionEndpoint;

},{"./Endpoint":31,"inherits":"inherits","kurento-client":"kurento-client"}],39:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Endpoint = require('./Endpoint');


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  Interface for endpoints the require a URI to work. An example of this, would
 *
 * @abstract
 * @extends module:core/abstracts.Endpoint
 *
 * @constructor module:core/abstracts.UriEndpoint
 *
 * @fires {@link module:core#event:UriEndpointStateChanged UriEndpointStateChanged}
 */
function UriEndpoint(){
  UriEndpoint.super_.call(this);
};
inherits(UriEndpoint, Endpoint);


//
// Public properties
//

/**
 * State of the endpoint
 *
 * @alias module:core/abstracts.UriEndpoint#getState
 *
 * @param {module:core/abstracts.UriEndpoint~getStateCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.getState = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getState', callback), this)
};
/**
 * @callback module:core/abstracts.UriEndpoint~getStateCallback
 * @param {external:Error} error
 * @param {module:core/complexTypes.UriEndpointState} result
 */

/**
 * The uri for this endpoint.
 *
 * @alias module:core/abstracts.UriEndpoint#getUri
 *
 * @param {module:core/abstracts.UriEndpoint~getUriCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.getUri = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getUri', callback), this)
};
/**
 * @callback module:core/abstracts.UriEndpoint~getUriCallback
 * @param {external:Error} error
 * @param {external:String} result
 */


//
// Public methods
//

/**
 * Pauses the feed
 *
 * @alias module:core/abstracts.UriEndpoint.pause
 *
 * @param {module:core/abstracts.UriEndpoint~pauseCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.pause = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'pause', callback), this)
};
/**
 * @callback module:core/abstracts.UriEndpoint~pauseCallback
 * @param {external:Error} error
 */

/**
 * Stops the feed
 *
 * @alias module:core/abstracts.UriEndpoint.stop
 *
 * @param {module:core/abstracts.UriEndpoint~stopCallback} [callback]
 *
 * @return {external:Promise}
 */
UriEndpoint.prototype.stop = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'stop', callback), this)
};
/**
 * @callback module:core/abstracts.UriEndpoint~stopCallback
 * @param {external:Error} error
 */


/**
 * @alias module:core/abstracts.UriEndpoint.constructorParams
 */
UriEndpoint.constructorParams = {
};

/**
 * @alias module:core/abstracts.UriEndpoint.events
 *
 * @extends module:core/abstracts.Endpoint.events
 */
UriEndpoint.events = Endpoint.events.concat(['UriEndpointStateChanged']);


/**
 * Checker for {@link module:core/abstracts.UriEndpoint}
 *
 * @memberof module:core/abstracts
 *
 * @param {external:String} key
 * @param {module:core/abstracts.UriEndpoint} value
 */
function checkUriEndpoint(key, value)
{
  if(!(value instanceof UriEndpoint))
    throw ChecktypeError(key, UriEndpoint, value);
};


module.exports = UriEndpoint;

UriEndpoint.check = checkUriEndpoint;

},{"./Endpoint":31,"inherits":"inherits","kurento-client":"kurento-client"}],40:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module core/abstracts
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

var BaseRtpEndpoint = require('./BaseRtpEndpoint');
var Endpoint = require('./Endpoint');
var Filter = require('./Filter');
var Hub = require('./Hub');
var MediaElement = require('./MediaElement');
var MediaObject = require('./MediaObject');
var SdpEndpoint = require('./SdpEndpoint');
var ServerManager = require('./ServerManager');
var SessionEndpoint = require('./SessionEndpoint');
var UriEndpoint = require('./UriEndpoint');


exports.BaseRtpEndpoint = BaseRtpEndpoint;
exports.Endpoint = Endpoint;
exports.Filter = Filter;
exports.Hub = Hub;
exports.MediaElement = MediaElement;
exports.MediaObject = MediaObject;
exports.SdpEndpoint = SdpEndpoint;
exports.ServerManager = ServerManager;
exports.SessionEndpoint = SessionEndpoint;
exports.UriEndpoint = UriEndpoint;

},{"./BaseRtpEndpoint":30,"./Endpoint":31,"./Filter":32,"./Hub":33,"./MediaElement":34,"./MediaObject":35,"./SdpEndpoint":36,"./ServerManager":37,"./SessionEndpoint":38,"./UriEndpoint":39}],41:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Format for audio media
 *
 * @constructor module:core/complexTypes.AudioCaps
 *
 * @property {module:core/complexTypes.AudioCodec} codec
 *  Audio codec
 * @property {external:Integer} bitrate
 *  Bitrate
 */
function AudioCaps(audioCapsDict){
  if(!(this instanceof AudioCaps))
    return new AudioCaps(audioCapsDict)

  audioCapsDict = audioCapsDict || {}

  // Check audioCapsDict has the required fields
  // 
  // checkType('AudioCodec', 'audioCapsDict.codec', audioCapsDict.codec, {required: true});
  //  
  // checkType('int', 'audioCapsDict.bitrate', audioCapsDict.bitrate, {required: true});
  //  

  // Init parent class
  AudioCaps.super_.call(this, audioCapsDict)

  // Set object properties
  Object.defineProperties(this, {
    codec: {
      writable: true,
      enumerable: true,
      value: audioCapsDict.codec
    },
    bitrate: {
      writable: true,
      enumerable: true,
      value: audioCapsDict.bitrate
    }
  })
}
inherits(AudioCaps, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(AudioCaps.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "AudioCaps"
  }
})

/**
 * Checker for {@link module:core/complexTypes.AudioCaps}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.AudioCaps} value
 */
function checkAudioCaps(key, value)
{
  if(!(value instanceof AudioCaps))
    throw ChecktypeError(key, AudioCaps, value);
};


module.exports = AudioCaps;

AudioCaps.check = checkAudioCaps;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],42:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Codec used for transmission of audio.
 *
 * @typedef core/complexTypes.AudioCodec
 *
 * @type {(OPUS|PCMU|RAW)}
 */

/**
 * Checker for {@link module:core/complexTypes.AudioCodec}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.AudioCodec} value
 */
function checkAudioCodec(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('OPUS|PCMU|RAW'))
    throw SyntaxError(key+' param is not one of [OPUS|PCMU|RAW] ('+value+')');
};


module.exports = checkAudioCodec;

},{"kurento-client":"kurento-client"}],43:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Defines specific configuration for codecs
 *
 * @constructor module:core/complexTypes.CodecConfiguration
 *
 * @property {external:String} name
 *  Name of the codec. Must follow this format: <encoding name>/<clock 
 *  rate>[/<encoding parameters>]
 * @property {external:String} properties
 *  String used for tuning codec properties
 */
function CodecConfiguration(codecConfigurationDict){
  if(!(this instanceof CodecConfiguration))
    return new CodecConfiguration(codecConfigurationDict)

  codecConfigurationDict = codecConfigurationDict || {}

  // Check codecConfigurationDict has the required fields
  // 
  // checkType('String', 'codecConfigurationDict.name', codecConfigurationDict.name);
  //  
  // checkType('String', 'codecConfigurationDict.properties', codecConfigurationDict.properties);
  //  

  // Init parent class
  CodecConfiguration.super_.call(this, codecConfigurationDict)

  // Set object properties
  Object.defineProperties(this, {
    name: {
      writable: true,
      enumerable: true,
      value: codecConfigurationDict.name
    },
    properties: {
      writable: true,
      enumerable: true,
      value: codecConfigurationDict.properties
    }
  })
}
inherits(CodecConfiguration, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(CodecConfiguration.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "CodecConfiguration"
  }
})

/**
 * Checker for {@link module:core/complexTypes.CodecConfiguration}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.CodecConfiguration} value
 */
function checkCodecConfiguration(key, value)
{
  if(!(value instanceof CodecConfiguration))
    throw ChecktypeError(key, CodecConfiguration, value);
};


module.exports = CodecConfiguration;

CodecConfiguration.check = checkCodecConfiguration;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],44:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var ChecktypeError = require('kurento-client').checkType.ChecktypeError;


/**
 * @constructor module:core/complexTypes.ComplexType
 *
 * @abstract
 */
function ComplexType(){}

// Based on http://stackoverflow.com/a/14078260/586382
ComplexType.prototype.toJSON = function()
{
  var result = {};

  for(var key in this)
  {
    var value = this[key]

    if(typeof value !== 'function')
      result[key] = value;
  }

  return result;
}


/**
 * Checker for {@link core/complexTypes.ComplexType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ComplexType} value
 */
function checkComplexType(key, value)
{
  if(!(value instanceof ComplexType))
    throw ChecktypeError(key, ComplexType, value);
};


module.exports = ComplexType;

ComplexType.check = checkComplexType;

},{"kurento-client":"kurento-client"}],45:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * State of the connection.
 *
 * @typedef core/complexTypes.ConnectionState
 *
 * @type {(DISCONNECTED|CONNECTED)}
 */

/**
 * Checker for {@link module:core/complexTypes.ConnectionState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ConnectionState} value
 */
function checkConnectionState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('DISCONNECTED|CONNECTED'))
    throw SyntaxError(key+' param is not one of [DISCONNECTED|CONNECTED] ('+value+')');
};


module.exports = checkConnectionState;

},{"kurento-client":"kurento-client"}],46:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * @constructor module:core/complexTypes.ElementConnectionData
 *
 * @property {module:core/abstracts.MediaElement} source
 *  The source element in the connection
 * @property {module:core/abstracts.MediaElement} sink
 *  The sink element in the connection
 * @property {module:core/complexTypes.MediaType} type
 *  MediaType of the connection
 * @property {external:String} sourceDescription
 *  Description of source media. Could be emty.
 * @property {external:String} sinkDescription
 *  Description of sink media. Could be emty.
 */
function ElementConnectionData(elementConnectionDataDict){
  if(!(this instanceof ElementConnectionData))
    return new ElementConnectionData(elementConnectionDataDict)

  elementConnectionDataDict = elementConnectionDataDict || {}

  // Check elementConnectionDataDict has the required fields
  // 
  // checkType('MediaElement', 'elementConnectionDataDict.source', elementConnectionDataDict.source, {required: true});
  //  
  // checkType('MediaElement', 'elementConnectionDataDict.sink', elementConnectionDataDict.sink, {required: true});
  //  
  // checkType('MediaType', 'elementConnectionDataDict.type', elementConnectionDataDict.type, {required: true});
  //  
  // checkType('String', 'elementConnectionDataDict.sourceDescription', elementConnectionDataDict.sourceDescription, {required: true});
  //  
  // checkType('String', 'elementConnectionDataDict.sinkDescription', elementConnectionDataDict.sinkDescription, {required: true});
  //  

  // Init parent class
  ElementConnectionData.super_.call(this, elementConnectionDataDict)

  // Set object properties
  Object.defineProperties(this, {
    source: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.source
    },
    sink: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.sink
    },
    type: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.type
    },
    sourceDescription: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.sourceDescription
    },
    sinkDescription: {
      writable: true,
      enumerable: true,
      value: elementConnectionDataDict.sinkDescription
    }
  })
}
inherits(ElementConnectionData, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ElementConnectionData.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ElementConnectionData"
  }
})

/**
 * Checker for {@link module:core/complexTypes.ElementConnectionData}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ElementConnectionData} value
 */
function checkElementConnectionData(key, value)
{
  if(!(value instanceof ElementConnectionData))
    throw ChecktypeError(key, ElementConnectionData, value);
};


module.exports = ElementConnectionData;

ElementConnectionData.check = checkElementConnectionData;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],47:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Stats = require('./Stats');


/**
 * A dictionary that represents the stats gathered in the media element.
 *
 * @constructor module:core/complexTypes.ElementStats
 *
 * @property {external:double} inputAudioLatency
 *  @deprecated
 *  Audio average measured on the sink pad in nano seconds
 * @property {external:double} inputVideoLatency
 *  @deprecated
 *  Video average measured on the sink pad in nano seconds
 * @property {module:core/complexTypes.MediaLatencyStat} inputLatency
 *  The average time that buffers take to get on the input pads of this element 
 *  in nano seconds

 * @extends module:core.Stats
 */
function ElementStats(elementStatsDict){
  if(!(this instanceof ElementStats))
    return new ElementStats(elementStatsDict)

  elementStatsDict = elementStatsDict || {}

  // Check elementStatsDict has the required fields
  // 
  // checkType('double', 'elementStatsDict.inputAudioLatency', elementStatsDict.inputAudioLatency, {required: true});
  //  
  // checkType('double', 'elementStatsDict.inputVideoLatency', elementStatsDict.inputVideoLatency, {required: true});
  //  
  // checkType('MediaLatencyStat', 'elementStatsDict.inputLatency', elementStatsDict.inputLatency, {isArray: true, required: true});
  //  

  // Init parent class
  ElementStats.super_.call(this, elementStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    inputAudioLatency: {
      writable: true,
      enumerable: true,
      value: elementStatsDict.inputAudioLatency
    },
    inputVideoLatency: {
      writable: true,
      enumerable: true,
      value: elementStatsDict.inputVideoLatency
    },
    inputLatency: {
      writable: true,
      enumerable: true,
      value: elementStatsDict.inputLatency
    }
  })
}
inherits(ElementStats, Stats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ElementStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ElementStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.ElementStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ElementStats} value
 */
function checkElementStats(key, value)
{
  if(!(value instanceof ElementStats))
    throw ChecktypeError(key, ElementStats, value);
};


module.exports = ElementStats;

ElementStats.check = checkElementStats;

},{"./Stats":77,"inherits":"inherits","kurento-client":"kurento-client"}],48:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ElementStats = require('./ElementStats');


/**
 * A dictionary that represents the stats gathered in the endpoint element.
 *
 * @constructor module:core/complexTypes.EndpointStats
 *
 * @property {external:double} audioE2ELatency
 *  @deprecated
 *  End-to-end audio latency measured in nano seconds
 * @property {external:double} videoE2ELatency
 *  @deprecated
 *  End-to-end video latency measured in nano seconds
 * @property {module:core/complexTypes.MediaLatencyStat} E2ELatency
 *  The average end to end latency for each media stream measured in nano 
 *  seconds

 * @extends module:core.ElementStats
 */
function EndpointStats(endpointStatsDict){
  if(!(this instanceof EndpointStats))
    return new EndpointStats(endpointStatsDict)

  endpointStatsDict = endpointStatsDict || {}

  // Check endpointStatsDict has the required fields
  // 
  // checkType('double', 'endpointStatsDict.audioE2ELatency', endpointStatsDict.audioE2ELatency, {required: true});
  //  
  // checkType('double', 'endpointStatsDict.videoE2ELatency', endpointStatsDict.videoE2ELatency, {required: true});
  //  
  // checkType('MediaLatencyStat', 'endpointStatsDict.E2ELatency', endpointStatsDict.E2ELatency, {isArray: true, required: true});
  //  

  // Init parent class
  EndpointStats.super_.call(this, endpointStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    audioE2ELatency: {
      writable: true,
      enumerable: true,
      value: endpointStatsDict.audioE2ELatency
    },
    videoE2ELatency: {
      writable: true,
      enumerable: true,
      value: endpointStatsDict.videoE2ELatency
    },
    E2ELatency: {
      writable: true,
      enumerable: true,
      value: endpointStatsDict.E2ELatency
    }
  })
}
inherits(EndpointStats, ElementStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(EndpointStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "EndpointStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.EndpointStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.EndpointStats} value
 */
function checkEndpointStats(key, value)
{
  if(!(value instanceof EndpointStats))
    throw ChecktypeError(key, EndpointStats, value);
};


module.exports = EndpointStats;

EndpointStats.check = checkEndpointStats;

},{"./ElementStats":47,"inherits":"inherits","kurento-client":"kurento-client"}],49:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Type of filter to be created.
 * Can take the values AUDIO, VIDEO or AUTODETECT.
 *
 * @typedef core/complexTypes.FilterType
 *
 * @type {(AUDIO|AUTODETECT|VIDEO)}
 */

/**
 * Checker for {@link module:core/complexTypes.FilterType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.FilterType} value
 */
function checkFilterType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('AUDIO|AUTODETECT|VIDEO'))
    throw SyntaxError(key+' param is not one of [AUDIO|AUTODETECT|VIDEO] ('+value+')');
};


module.exports = checkFilterType;

},{"kurento-client":"kurento-client"}],50:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Type that represents a fraction of an integer numerator over an integer 
 * denominator
 *
 * @constructor module:core/complexTypes.Fraction
 *
 * @property {external:Integer} numerator
 *  the numerator of the fraction
 * @property {external:Integer} denominator
 *  the denominator of the fraction
 */
function Fraction(fractionDict){
  if(!(this instanceof Fraction))
    return new Fraction(fractionDict)

  fractionDict = fractionDict || {}

  // Check fractionDict has the required fields
  // 
  // checkType('int', 'fractionDict.numerator', fractionDict.numerator, {required: true});
  //  
  // checkType('int', 'fractionDict.denominator', fractionDict.denominator, {required: true});
  //  

  // Init parent class
  Fraction.super_.call(this, fractionDict)

  // Set object properties
  Object.defineProperties(this, {
    numerator: {
      writable: true,
      enumerable: true,
      value: fractionDict.numerator
    },
    denominator: {
      writable: true,
      enumerable: true,
      value: fractionDict.denominator
    }
  })
}
inherits(Fraction, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(Fraction.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "Fraction"
  }
})

/**
 * Checker for {@link module:core/complexTypes.Fraction}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.Fraction} value
 */
function checkFraction(key, value)
{
  if(!(value instanceof Fraction))
    throw ChecktypeError(key, Fraction, value);
};


module.exports = Fraction;

Fraction.check = checkFraction;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],51:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Details of gstreamer dot graphs
 *
 * @typedef core/complexTypes.GstreamerDotDetails
 *
 * @type {(SHOW_MEDIA_TYPE|SHOW_CAPS_DETAILS|SHOW_NON_DEFAULT_PARAMS|SHOW_STATES|SHOW_FULL_PARAMS|SHOW_ALL|SHOW_VERBOSE)}
 */

/**
 * Checker for {@link module:core/complexTypes.GstreamerDotDetails}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.GstreamerDotDetails} value
 */
function checkGstreamerDotDetails(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('SHOW_MEDIA_TYPE|SHOW_CAPS_DETAILS|SHOW_NON_DEFAULT_PARAMS|SHOW_STATES|SHOW_FULL_PARAMS|SHOW_ALL|SHOW_VERBOSE'))
    throw SyntaxError(key+' param is not one of [SHOW_MEDIA_TYPE|SHOW_CAPS_DETAILS|SHOW_NON_DEFAULT_PARAMS|SHOW_STATES|SHOW_FULL_PARAMS|SHOW_ALL|SHOW_VERBOSE] ('+value+')');
};


module.exports = checkGstreamerDotDetails;

},{"kurento-client":"kurento-client"}],52:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Flowing state of the media.
 *
 * @typedef core/complexTypes.MediaFlowState
 *
 * @type {(FLOWING|NOT_FLOWING)}
 */

/**
 * Checker for {@link module:core/complexTypes.MediaFlowState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaFlowState} value
 */
function checkMediaFlowState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('FLOWING|NOT_FLOWING'))
    throw SyntaxError(key+' param is not one of [FLOWING|NOT_FLOWING] ('+value+')');
};


module.exports = checkMediaFlowState;

},{"kurento-client":"kurento-client"}],53:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * A dictionary that represents the stats gathered.
 *
 * @constructor module:core/complexTypes.MediaLatencyStat
 *
 * @property {external:String} name
 *  The identifier of the media stream
 * @property {module:core/complexTypes.MediaType} type
 *  Type of media stream
 * @property {external:double} avg
 *  The average time that buffers take to get on the input pad of this element
 */
function MediaLatencyStat(mediaLatencyStatDict){
  if(!(this instanceof MediaLatencyStat))
    return new MediaLatencyStat(mediaLatencyStatDict)

  mediaLatencyStatDict = mediaLatencyStatDict || {}

  // Check mediaLatencyStatDict has the required fields
  // 
  // checkType('String', 'mediaLatencyStatDict.name', mediaLatencyStatDict.name, {required: true});
  //  
  // checkType('MediaType', 'mediaLatencyStatDict.type', mediaLatencyStatDict.type, {required: true});
  //  
  // checkType('double', 'mediaLatencyStatDict.avg', mediaLatencyStatDict.avg, {required: true});
  //  

  // Init parent class
  MediaLatencyStat.super_.call(this, mediaLatencyStatDict)

  // Set object properties
  Object.defineProperties(this, {
    name: {
      writable: true,
      enumerable: true,
      value: mediaLatencyStatDict.name
    },
    type: {
      writable: true,
      enumerable: true,
      value: mediaLatencyStatDict.type
    },
    avg: {
      writable: true,
      enumerable: true,
      value: mediaLatencyStatDict.avg
    }
  })
}
inherits(MediaLatencyStat, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(MediaLatencyStat.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "MediaLatencyStat"
  }
})

/**
 * Checker for {@link module:core/complexTypes.MediaLatencyStat}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaLatencyStat} value
 */
function checkMediaLatencyStat(key, value)
{
  if(!(value instanceof MediaLatencyStat))
    throw ChecktypeError(key, MediaLatencyStat, value);
};


module.exports = MediaLatencyStat;

MediaLatencyStat.check = checkMediaLatencyStat;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],54:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * State of the media.
 *
 * @typedef core/complexTypes.MediaState
 *
 * @type {(DISCONNECTED|CONNECTED)}
 */

/**
 * Checker for {@link module:core/complexTypes.MediaState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaState} value
 */
function checkMediaState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('DISCONNECTED|CONNECTED'))
    throw SyntaxError(key+' param is not one of [DISCONNECTED|CONNECTED] ('+value+')');
};


module.exports = checkMediaState;

},{"kurento-client":"kurento-client"}],55:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Transcoding state for a media.
 *
 * @typedef core/complexTypes.MediaTranscodingState
 *
 * @type {(TRANSCODING|NOT_TRANSCODING)}
 */

/**
 * Checker for {@link module:core/complexTypes.MediaTranscodingState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaTranscodingState} value
 */
function checkMediaTranscodingState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('TRANSCODING|NOT_TRANSCODING'))
    throw SyntaxError(key+' param is not one of [TRANSCODING|NOT_TRANSCODING] ('+value+')');
};


module.exports = checkMediaTranscodingState;

},{"kurento-client":"kurento-client"}],56:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Type of media stream to be exchanged.
 * Can take the values AUDIO, DATA or VIDEO.
 *
 * @typedef core/complexTypes.MediaType
 *
 * @type {(AUDIO|DATA|VIDEO)}
 */

/**
 * Checker for {@link module:core/complexTypes.MediaType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.MediaType} value
 */
function checkMediaType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('AUDIO|DATA|VIDEO'))
    throw SyntaxError(key+' param is not one of [AUDIO|DATA|VIDEO] ('+value+')');
};


module.exports = checkMediaType;

},{"kurento-client":"kurento-client"}],57:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Description of a loaded modules
 *
 * @constructor module:core/complexTypes.ModuleInfo
 *
 * @property {external:String} version
 *  Module version
 * @property {external:String} name
 *  Module name
 * @property {external:String} generationTime
 *  Time that this module was generated
 * @property {external:String} factories
 *  Module available factories
 */
function ModuleInfo(moduleInfoDict){
  if(!(this instanceof ModuleInfo))
    return new ModuleInfo(moduleInfoDict)

  moduleInfoDict = moduleInfoDict || {}

  // Check moduleInfoDict has the required fields
  // 
  // checkType('String', 'moduleInfoDict.version', moduleInfoDict.version, {required: true});
  //  
  // checkType('String', 'moduleInfoDict.name', moduleInfoDict.name, {required: true});
  //  
  // checkType('String', 'moduleInfoDict.generationTime', moduleInfoDict.generationTime, {required: true});
  //  
  // checkType('String', 'moduleInfoDict.factories', moduleInfoDict.factories, {isArray: true, required: true});
  //  

  // Init parent class
  ModuleInfo.super_.call(this, moduleInfoDict)

  // Set object properties
  Object.defineProperties(this, {
    version: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.version
    },
    name: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.name
    },
    generationTime: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.generationTime
    },
    factories: {
      writable: true,
      enumerable: true,
      value: moduleInfoDict.factories
    }
  })
}
inherits(ModuleInfo, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ModuleInfo.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ModuleInfo"
  }
})

/**
 * Checker for {@link module:core/complexTypes.ModuleInfo}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ModuleInfo} value
 */
function checkModuleInfo(key, value)
{
  if(!(value instanceof ModuleInfo))
    throw ChecktypeError(key, ModuleInfo, value);
};


module.exports = ModuleInfo;

ModuleInfo.check = checkModuleInfo;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],58:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 *
 * @constructor module:core/complexTypes.RTCCertificateStats
 *
 * @property {external:String} fingerprint
 *  Only use the fingerprint value as defined in Section 5 of [RFC4572].
 * @property {external:String} fingerprintAlgorithm
 *  For instance, 'sha-256'.
 * @property {external:String} base64Certificate
 *  For example, DER-encoded, base-64 representation of a certifiate.
 * @property {external:String} issuerCertificateId

 * @extends module:core.RTCStats
 */
function RTCCertificateStats(rTCCertificateStatsDict){
  if(!(this instanceof RTCCertificateStats))
    return new RTCCertificateStats(rTCCertificateStatsDict)

  rTCCertificateStatsDict = rTCCertificateStatsDict || {}

  // Check rTCCertificateStatsDict has the required fields
  // 
  // checkType('String', 'rTCCertificateStatsDict.fingerprint', rTCCertificateStatsDict.fingerprint, {required: true});
  //  
  // checkType('String', 'rTCCertificateStatsDict.fingerprintAlgorithm', rTCCertificateStatsDict.fingerprintAlgorithm, {required: true});
  //  
  // checkType('String', 'rTCCertificateStatsDict.base64Certificate', rTCCertificateStatsDict.base64Certificate, {required: true});
  //  
  // checkType('String', 'rTCCertificateStatsDict.issuerCertificateId', rTCCertificateStatsDict.issuerCertificateId, {required: true});
  //  

  // Init parent class
  RTCCertificateStats.super_.call(this, rTCCertificateStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    fingerprint: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.fingerprint
    },
    fingerprintAlgorithm: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.fingerprintAlgorithm
    },
    base64Certificate: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.base64Certificate
    },
    issuerCertificateId: {
      writable: true,
      enumerable: true,
      value: rTCCertificateStatsDict.issuerCertificateId
    }
  })
}
inherits(RTCCertificateStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCCertificateStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCCertificateStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCCertificateStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCCertificateStats} value
 */
function checkRTCCertificateStats(key, value)
{
  if(!(value instanceof RTCCertificateStats))
    throw ChecktypeError(key, RTCCertificateStats, value);
};


module.exports = RTCCertificateStats;

RTCCertificateStats.check = checkRTCCertificateStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],59:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * RTC codec statistics
 *
 * @constructor module:core/complexTypes.RTCCodec
 *
 * @property {external:int64} payloadType
 *  Payload type as used in RTP encoding.
 * @property {external:String} codec
 *  e.g., video/vp8 or equivalent.
 * @property {external:int64} clockRate
 *  Represents the media sampling rate.
 * @property {external:int64} channels
 *  Use 2 for stereo, missing for most other cases.
 * @property {external:String} parameters
 *  From the SDP description line.

 * @extends module:core.RTCStats
 */
function RTCCodec(rTCCodecDict){
  if(!(this instanceof RTCCodec))
    return new RTCCodec(rTCCodecDict)

  rTCCodecDict = rTCCodecDict || {}

  // Check rTCCodecDict has the required fields
  // 
  // checkType('int64', 'rTCCodecDict.payloadType', rTCCodecDict.payloadType, {required: true});
  //  
  // checkType('String', 'rTCCodecDict.codec', rTCCodecDict.codec, {required: true});
  //  
  // checkType('int64', 'rTCCodecDict.clockRate', rTCCodecDict.clockRate, {required: true});
  //  
  // checkType('int64', 'rTCCodecDict.channels', rTCCodecDict.channels, {required: true});
  //  
  // checkType('String', 'rTCCodecDict.parameters', rTCCodecDict.parameters, {required: true});
  //  

  // Init parent class
  RTCCodec.super_.call(this, rTCCodecDict)

  // Set object properties
  Object.defineProperties(this, {
    payloadType: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.payloadType
    },
    codec: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.codec
    },
    clockRate: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.clockRate
    },
    channels: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.channels
    },
    parameters: {
      writable: true,
      enumerable: true,
      value: rTCCodecDict.parameters
    }
  })
}
inherits(RTCCodec, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCCodec.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCCodec"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCCodec}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCCodec} value
 */
function checkRTCCodec(key, value)
{
  if(!(value instanceof RTCCodec))
    throw ChecktypeError(key, RTCCodec, value);
};


module.exports = RTCCodec;

RTCCodec.check = checkRTCCodec;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],60:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Represents the state of the RTCDataChannel
 *
 * @typedef core/complexTypes.RTCDataChannelState
 *
 * @type {(connecting|open|closing|closed)}
 */

/**
 * Checker for {@link module:core/complexTypes.RTCDataChannelState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCDataChannelState} value
 */
function checkRTCDataChannelState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('connecting|open|closing|closed'))
    throw SyntaxError(key+' param is not one of [connecting|open|closing|closed] ('+value+')');
};


module.exports = checkRTCDataChannelState;

},{"kurento-client":"kurento-client"}],61:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to RTC data channels.
 *
 * @constructor module:core/complexTypes.RTCDataChannelStats
 *
 * @property {external:String} label
 *  The RTCDatachannel label.
 * @property {external:String} protocol
 *  The protocol used.
 * @property {external:int64} datachannelid
 *  The RTCDatachannel identifier.
 * @property {module:core/complexTypes.RTCDataChannelState} state
 *  The state of the RTCDatachannel.
 * @property {external:int64} messagesSent
 *  Represents the total number of API 'message' events sent.
 * @property {external:int64} bytesSent
 *  Represents the total number of payload bytes sent on this RTCDatachannel, 
 *  i.e., not including headers or padding.
 * @property {external:int64} messagesReceived
 *  Represents the total number of API 'message' events received.
 * @property {external:int64} bytesReceived
 *  Represents the total number of bytes received on this RTCDatachannel, i.e., 
 *  not including headers or padding.

 * @extends module:core.RTCStats
 */
function RTCDataChannelStats(rTCDataChannelStatsDict){
  if(!(this instanceof RTCDataChannelStats))
    return new RTCDataChannelStats(rTCDataChannelStatsDict)

  rTCDataChannelStatsDict = rTCDataChannelStatsDict || {}

  // Check rTCDataChannelStatsDict has the required fields
  // 
  // checkType('String', 'rTCDataChannelStatsDict.label', rTCDataChannelStatsDict.label, {required: true});
  //  
  // checkType('String', 'rTCDataChannelStatsDict.protocol', rTCDataChannelStatsDict.protocol, {required: true});
  //  
  // checkType('int64', 'rTCDataChannelStatsDict.datachannelid', rTCDataChannelStatsDict.datachannelid, {required: true});
  //  
  // checkType('RTCDataChannelState', 'rTCDataChannelStatsDict.state', rTCDataChannelStatsDict.state, {required: true});
  //  
  // checkType('int64', 'rTCDataChannelStatsDict.messagesSent', rTCDataChannelStatsDict.messagesSent, {required: true});
  //  
  // checkType('int64', 'rTCDataChannelStatsDict.bytesSent', rTCDataChannelStatsDict.bytesSent, {required: true});
  //  
  // checkType('int64', 'rTCDataChannelStatsDict.messagesReceived', rTCDataChannelStatsDict.messagesReceived, {required: true});
  //  
  // checkType('int64', 'rTCDataChannelStatsDict.bytesReceived', rTCDataChannelStatsDict.bytesReceived, {required: true});
  //  

  // Init parent class
  RTCDataChannelStats.super_.call(this, rTCDataChannelStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    label: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.label
    },
    protocol: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.protocol
    },
    datachannelid: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.datachannelid
    },
    state: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.state
    },
    messagesSent: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.messagesSent
    },
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.bytesSent
    },
    messagesReceived: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.messagesReceived
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCDataChannelStatsDict.bytesReceived
    }
  })
}
inherits(RTCDataChannelStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCDataChannelStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCDataChannelStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCDataChannelStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCDataChannelStats} value
 */
function checkRTCDataChannelStats(key, value)
{
  if(!(value instanceof RTCDataChannelStats))
    throw ChecktypeError(key, RTCDataChannelStats, value);
};


module.exports = RTCDataChannelStats;

RTCDataChannelStats.check = checkRTCDataChannelStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],62:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 *
 * @constructor module:core/complexTypes.RTCIceCandidateAttributes
 *
 * @property {external:String} ipAddress
 *  It is the IP address of the candidate, allowing for IPv4 addresses, IPv6 
 *  addresses, and fully qualified domain names (FQDNs).
 * @property {external:int64} portNumber
 *  It is the port number of the candidate.
 * @property {external:String} transport
 *  Valid values for transport is one of udp and tcp. Based on the 'transport' 
 *  defined in [RFC5245] section 15.1.
 * @property {module:core/complexTypes.RTCStatsIceCandidateType} candidateType
 *  The enumeration RTCStatsIceCandidateType is based on the cand-type defined 
 *  in [RFC5245] section 15.1.
 * @property {external:int64} priority
 *  Represents the priority of the candidate
 * @property {external:String} addressSourceUrl
 *  The URL of the TURN or STUN server indicated in the RTCIceServers that 
 *  translated this IP address.

 * @extends module:core.RTCStats
 */
function RTCIceCandidateAttributes(rTCIceCandidateAttributesDict){
  if(!(this instanceof RTCIceCandidateAttributes))
    return new RTCIceCandidateAttributes(rTCIceCandidateAttributesDict)

  rTCIceCandidateAttributesDict = rTCIceCandidateAttributesDict || {}

  // Check rTCIceCandidateAttributesDict has the required fields
  // 
  // checkType('String', 'rTCIceCandidateAttributesDict.ipAddress', rTCIceCandidateAttributesDict.ipAddress, {required: true});
  //  
  // checkType('int64', 'rTCIceCandidateAttributesDict.portNumber', rTCIceCandidateAttributesDict.portNumber, {required: true});
  //  
  // checkType('String', 'rTCIceCandidateAttributesDict.transport', rTCIceCandidateAttributesDict.transport, {required: true});
  //  
  // checkType('RTCStatsIceCandidateType', 'rTCIceCandidateAttributesDict.candidateType', rTCIceCandidateAttributesDict.candidateType, {required: true});
  //  
  // checkType('int64', 'rTCIceCandidateAttributesDict.priority', rTCIceCandidateAttributesDict.priority, {required: true});
  //  
  // checkType('String', 'rTCIceCandidateAttributesDict.addressSourceUrl', rTCIceCandidateAttributesDict.addressSourceUrl, {required: true});
  //  

  // Init parent class
  RTCIceCandidateAttributes.super_.call(this, rTCIceCandidateAttributesDict)

  // Set object properties
  Object.defineProperties(this, {
    ipAddress: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.ipAddress
    },
    portNumber: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.portNumber
    },
    transport: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.transport
    },
    candidateType: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.candidateType
    },
    priority: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.priority
    },
    addressSourceUrl: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidateAttributesDict.addressSourceUrl
    }
  })
}
inherits(RTCIceCandidateAttributes, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCIceCandidateAttributes.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCIceCandidateAttributes"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCIceCandidateAttributes}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCIceCandidateAttributes} value
 */
function checkRTCIceCandidateAttributes(key, value)
{
  if(!(value instanceof RTCIceCandidateAttributes))
    throw ChecktypeError(key, RTCIceCandidateAttributes, value);
};


module.exports = RTCIceCandidateAttributes;

RTCIceCandidateAttributes.check = checkRTCIceCandidateAttributes;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],63:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 *
 * @constructor module:core/complexTypes.RTCIceCandidatePairStats
 *
 * @property {external:String} transportId
 *  It is a unique identifier that is associated to the object that was 
 *  inspected to produce the RTCTransportStats associated with this candidate 
 *  pair.
 * @property {external:String} localCandidateId
 *  It is a unique identifier that is associated to the object that was 
 *  inspected to produce the RTCIceCandidateAttributes for the local candidate 
 *  associated with this candidate pair.
 * @property {external:String} remoteCandidateId
 *  It is a unique identifier that is associated to the object that was 
 *  inspected to produce the RTCIceCandidateAttributes for the remote candidate 
 *  associated with this candidate pair.
 * @property {module:core/complexTypes.RTCStatsIceCandidatePairState} state
 *  Represents the state of the checklist for the local and remote candidates in
 * @property {external:int64} priority
 *  Calculated from candidate priorities as defined in [RFC5245] section 5.7.2.
 * @property {external:Boolean} nominated
 *  Related to updating the nominated flag described in Section 7.1.3.2.4 of 
 *  [RFC5245].
 * @property {external:Boolean} writable
 *  Has gotten ACK to an ICE request.
 * @property {external:Boolean} readable
 *  Has gotten a valid incoming ICE request.
 * @property {external:int64} bytesSent
 *  Represents the total number of payload bytes sent on this candidate pair, 
 *  i.e., not including headers or padding.
 * @property {external:int64} bytesReceived
 *  Represents the total number of payload bytes received on this candidate 
 *  pair, i.e., not including headers or padding.
 * @property {external:double} roundTripTime
 *  Represents the RTT computed by the STUN connectivity checks
 * @property {external:double} availableOutgoingBitrate
 *  Measured in Bits per second, and is implementation dependent. It may be 
 *  calculated by the underlying congestion control.
 * @property {external:double} availableIncomingBitrate
 *  Measured in Bits per second, and is implementation dependent. It may be 
 *  calculated by the underlying congestion control.

 * @extends module:core.RTCStats
 */
function RTCIceCandidatePairStats(rTCIceCandidatePairStatsDict){
  if(!(this instanceof RTCIceCandidatePairStats))
    return new RTCIceCandidatePairStats(rTCIceCandidatePairStatsDict)

  rTCIceCandidatePairStatsDict = rTCIceCandidatePairStatsDict || {}

  // Check rTCIceCandidatePairStatsDict has the required fields
  // 
  // checkType('String', 'rTCIceCandidatePairStatsDict.transportId', rTCIceCandidatePairStatsDict.transportId, {required: true});
  //  
  // checkType('String', 'rTCIceCandidatePairStatsDict.localCandidateId', rTCIceCandidatePairStatsDict.localCandidateId, {required: true});
  //  
  // checkType('String', 'rTCIceCandidatePairStatsDict.remoteCandidateId', rTCIceCandidatePairStatsDict.remoteCandidateId, {required: true});
  //  
  // checkType('RTCStatsIceCandidatePairState', 'rTCIceCandidatePairStatsDict.state', rTCIceCandidatePairStatsDict.state, {required: true});
  //  
  // checkType('int64', 'rTCIceCandidatePairStatsDict.priority', rTCIceCandidatePairStatsDict.priority, {required: true});
  //  
  // checkType('boolean', 'rTCIceCandidatePairStatsDict.nominated', rTCIceCandidatePairStatsDict.nominated, {required: true});
  //  
  // checkType('boolean', 'rTCIceCandidatePairStatsDict.writable', rTCIceCandidatePairStatsDict.writable, {required: true});
  //  
  // checkType('boolean', 'rTCIceCandidatePairStatsDict.readable', rTCIceCandidatePairStatsDict.readable, {required: true});
  //  
  // checkType('int64', 'rTCIceCandidatePairStatsDict.bytesSent', rTCIceCandidatePairStatsDict.bytesSent, {required: true});
  //  
  // checkType('int64', 'rTCIceCandidatePairStatsDict.bytesReceived', rTCIceCandidatePairStatsDict.bytesReceived, {required: true});
  //  
  // checkType('double', 'rTCIceCandidatePairStatsDict.roundTripTime', rTCIceCandidatePairStatsDict.roundTripTime, {required: true});
  //  
  // checkType('double', 'rTCIceCandidatePairStatsDict.availableOutgoingBitrate', rTCIceCandidatePairStatsDict.availableOutgoingBitrate, {required: true});
  //  
  // checkType('double', 'rTCIceCandidatePairStatsDict.availableIncomingBitrate', rTCIceCandidatePairStatsDict.availableIncomingBitrate, {required: true});
  //  

  // Init parent class
  RTCIceCandidatePairStats.super_.call(this, rTCIceCandidatePairStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    transportId: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.transportId
    },
    localCandidateId: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.localCandidateId
    },
    remoteCandidateId: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.remoteCandidateId
    },
    state: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.state
    },
    priority: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.priority
    },
    nominated: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.nominated
    },
    writable: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.writable
    },
    readable: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.readable
    },
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.bytesSent
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.bytesReceived
    },
    roundTripTime: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.roundTripTime
    },
    availableOutgoingBitrate: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.availableOutgoingBitrate
    },
    availableIncomingBitrate: {
      writable: true,
      enumerable: true,
      value: rTCIceCandidatePairStatsDict.availableIncomingBitrate
    }
  })
}
inherits(RTCIceCandidatePairStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCIceCandidatePairStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCIceCandidatePairStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCIceCandidatePairStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCIceCandidatePairStats} value
 */
function checkRTCIceCandidatePairStats(key, value)
{
  if(!(value instanceof RTCIceCandidatePairStats))
    throw ChecktypeError(key, RTCIceCandidatePairStats, value);
};


module.exports = RTCIceCandidatePairStats;

RTCIceCandidatePairStats.check = checkRTCIceCandidatePairStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],64:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCRTPStreamStats = require('./RTCRTPStreamStats');


/**
 * Statistics that represents the measurement metrics for the incoming media 
 * stream.
 *
 * @constructor module:core/complexTypes.RTCInboundRTPStreamStats
 *
 * @property {external:int64} packetsReceived
 *  Total number of RTP packets received for this SSRC.
 * @property {external:int64} bytesReceived
 *  Total number of bytes received for this SSRC.
 * @property {external:double} jitter
 *  Packet Jitter measured in seconds for this SSRC.

 * @extends module:core.RTCRTPStreamStats
 */
function RTCInboundRTPStreamStats(rTCInboundRTPStreamStatsDict){
  if(!(this instanceof RTCInboundRTPStreamStats))
    return new RTCInboundRTPStreamStats(rTCInboundRTPStreamStatsDict)

  rTCInboundRTPStreamStatsDict = rTCInboundRTPStreamStatsDict || {}

  // Check rTCInboundRTPStreamStatsDict has the required fields
  // 
  // checkType('int64', 'rTCInboundRTPStreamStatsDict.packetsReceived', rTCInboundRTPStreamStatsDict.packetsReceived, {required: true});
  //  
  // checkType('int64', 'rTCInboundRTPStreamStatsDict.bytesReceived', rTCInboundRTPStreamStatsDict.bytesReceived, {required: true});
  //  
  // checkType('double', 'rTCInboundRTPStreamStatsDict.jitter', rTCInboundRTPStreamStatsDict.jitter, {required: true});
  //  

  // Init parent class
  RTCInboundRTPStreamStats.super_.call(this, rTCInboundRTPStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    packetsReceived: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.packetsReceived
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.bytesReceived
    },
    jitter: {
      writable: true,
      enumerable: true,
      value: rTCInboundRTPStreamStatsDict.jitter
    }
  })
}
inherits(RTCInboundRTPStreamStats, RTCRTPStreamStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCInboundRTPStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCInboundRTPStreamStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCInboundRTPStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCInboundRTPStreamStats} value
 */
function checkRTCInboundRTPStreamStats(key, value)
{
  if(!(value instanceof RTCInboundRTPStreamStats))
    throw ChecktypeError(key, RTCInboundRTPStreamStats, value);
};


module.exports = RTCInboundRTPStreamStats;

RTCInboundRTPStreamStats.check = checkRTCInboundRTPStreamStats;

},{"./RTCRTPStreamStats":69,"inherits":"inherits","kurento-client":"kurento-client"}],65:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to the media stream.
 *
 * @constructor module:core/complexTypes.RTCMediaStreamStats
 *
 * @property {external:String} streamIdentifier
 *  Stream identifier.
 * @property {external:String} trackIds
 *  This is the id of the stats object, not the track.id.

 * @extends module:core.RTCStats
 */
function RTCMediaStreamStats(rTCMediaStreamStatsDict){
  if(!(this instanceof RTCMediaStreamStats))
    return new RTCMediaStreamStats(rTCMediaStreamStatsDict)

  rTCMediaStreamStatsDict = rTCMediaStreamStatsDict || {}

  // Check rTCMediaStreamStatsDict has the required fields
  // 
  // checkType('String', 'rTCMediaStreamStatsDict.streamIdentifier', rTCMediaStreamStatsDict.streamIdentifier, {required: true});
  //  
  // checkType('String', 'rTCMediaStreamStatsDict.trackIds', rTCMediaStreamStatsDict.trackIds, {isArray: true, required: true});
  //  

  // Init parent class
  RTCMediaStreamStats.super_.call(this, rTCMediaStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    streamIdentifier: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamStatsDict.streamIdentifier
    },
    trackIds: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamStatsDict.trackIds
    }
  })
}
inherits(RTCMediaStreamStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCMediaStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCMediaStreamStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCMediaStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCMediaStreamStats} value
 */
function checkRTCMediaStreamStats(key, value)
{
  if(!(value instanceof RTCMediaStreamStats))
    throw ChecktypeError(key, RTCMediaStreamStats, value);
};


module.exports = RTCMediaStreamStats;

RTCMediaStreamStats.check = checkRTCMediaStreamStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],66:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to the media stream.
 *
 * @constructor module:core/complexTypes.RTCMediaStreamTrackStats
 *
 * @property {external:String} trackIdentifier
 *  Represents the track.id property.
 * @property {external:Boolean} remoteSource
 *  true indicates that this is a remote source. false in other case.
 * @property {external:String} ssrcIds
 *  Synchronized sources.
 * @property {external:int64} frameWidth
 *  Only makes sense for video media streams and represents the width of the 
 *  video frame for this SSRC.
 * @property {external:int64} frameHeight
 *  Only makes sense for video media streams and represents the height of the 
 *  video frame for this SSRC.
 * @property {external:double} framesPerSecond
 *  Only valid for video. It represents the nominal FPS value.
 * @property {external:int64} framesSent
 *  Only valid for video. It represents the total number of frames sent for this
 * @property {external:int64} framesReceived
 *  Only valid for video and when remoteSource is set to true. It represents the
 * @property {external:int64} framesDecoded
 *  Only valid for video. It represents the total number of frames correctly 
 *  decoded for this SSRC. 
 * @property {external:int64} framesDropped
 *  Only valid for video. The total number of frames dropped predecode or 
 *  dropped because the frame missed its display deadline.
 * @property {external:int64} framesCorrupted
 *  Only valid for video. The total number of corrupted frames that have been 
 *  detected.
 * @property {external:double} audioLevel
 *  Only valid for audio, and the value is between 0..1 (linear), where 1.0 
 *  represents 0 dBov.
 * @property {external:double} echoReturnLoss
 *  Only present on audio tracks sourced from a microphone where echo 
 *  cancellation is applied. Calculated in decibels.
 * @property {external:double} echoReturnLossEnhancement
 *  Only present on audio tracks sourced from a microphone where echo 
 *  cancellation is applied.

 * @extends module:core.RTCStats
 */
function RTCMediaStreamTrackStats(rTCMediaStreamTrackStatsDict){
  if(!(this instanceof RTCMediaStreamTrackStats))
    return new RTCMediaStreamTrackStats(rTCMediaStreamTrackStatsDict)

  rTCMediaStreamTrackStatsDict = rTCMediaStreamTrackStatsDict || {}

  // Check rTCMediaStreamTrackStatsDict has the required fields
  // 
  // checkType('String', 'rTCMediaStreamTrackStatsDict.trackIdentifier', rTCMediaStreamTrackStatsDict.trackIdentifier, {required: true});
  //  
  // checkType('boolean', 'rTCMediaStreamTrackStatsDict.remoteSource', rTCMediaStreamTrackStatsDict.remoteSource, {required: true});
  //  
  // checkType('String', 'rTCMediaStreamTrackStatsDict.ssrcIds', rTCMediaStreamTrackStatsDict.ssrcIds, {isArray: true, required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.frameWidth', rTCMediaStreamTrackStatsDict.frameWidth, {required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.frameHeight', rTCMediaStreamTrackStatsDict.frameHeight, {required: true});
  //  
  // checkType('double', 'rTCMediaStreamTrackStatsDict.framesPerSecond', rTCMediaStreamTrackStatsDict.framesPerSecond, {required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.framesSent', rTCMediaStreamTrackStatsDict.framesSent, {required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.framesReceived', rTCMediaStreamTrackStatsDict.framesReceived, {required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.framesDecoded', rTCMediaStreamTrackStatsDict.framesDecoded, {required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.framesDropped', rTCMediaStreamTrackStatsDict.framesDropped, {required: true});
  //  
  // checkType('int64', 'rTCMediaStreamTrackStatsDict.framesCorrupted', rTCMediaStreamTrackStatsDict.framesCorrupted, {required: true});
  //  
  // checkType('double', 'rTCMediaStreamTrackStatsDict.audioLevel', rTCMediaStreamTrackStatsDict.audioLevel, {required: true});
  //  
  // checkType('double', 'rTCMediaStreamTrackStatsDict.echoReturnLoss', rTCMediaStreamTrackStatsDict.echoReturnLoss, {required: true});
  //  
  // checkType('double', 'rTCMediaStreamTrackStatsDict.echoReturnLossEnhancement', rTCMediaStreamTrackStatsDict.echoReturnLossEnhancement, {required: true});
  //  

  // Init parent class
  RTCMediaStreamTrackStats.super_.call(this, rTCMediaStreamTrackStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    trackIdentifier: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.trackIdentifier
    },
    remoteSource: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.remoteSource
    },
    ssrcIds: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.ssrcIds
    },
    frameWidth: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.frameWidth
    },
    frameHeight: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.frameHeight
    },
    framesPerSecond: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesPerSecond
    },
    framesSent: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesSent
    },
    framesReceived: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesReceived
    },
    framesDecoded: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesDecoded
    },
    framesDropped: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesDropped
    },
    framesCorrupted: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.framesCorrupted
    },
    audioLevel: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.audioLevel
    },
    echoReturnLoss: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.echoReturnLoss
    },
    echoReturnLossEnhancement: {
      writable: true,
      enumerable: true,
      value: rTCMediaStreamTrackStatsDict.echoReturnLossEnhancement
    }
  })
}
inherits(RTCMediaStreamTrackStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCMediaStreamTrackStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCMediaStreamTrackStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCMediaStreamTrackStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCMediaStreamTrackStats} value
 */
function checkRTCMediaStreamTrackStats(key, value)
{
  if(!(value instanceof RTCMediaStreamTrackStats))
    throw ChecktypeError(key, RTCMediaStreamTrackStats, value);
};


module.exports = RTCMediaStreamTrackStats;

RTCMediaStreamTrackStats.check = checkRTCMediaStreamTrackStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],67:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCRTPStreamStats = require('./RTCRTPStreamStats');


/**
 * Statistics that represents the measurement metrics for the outgoing media 
 * stream.
 *
 * @constructor module:core/complexTypes.RTCOutboundRTPStreamStats
 *
 * @property {external:int64} packetsSent
 *  Total number of RTP packets sent for this SSRC.
 * @property {external:int64} bytesSent
 *  Total number of bytes sent for this SSRC.
 * @property {external:double} targetBitrate
 *  Presently configured bitrate target of this SSRC, in bits per second.
 * @property {external:double} roundTripTime
 *  Estimated round trip time (seconds) for this SSRC based on the RTCP 
 *  timestamp.

 * @extends module:core.RTCRTPStreamStats
 */
function RTCOutboundRTPStreamStats(rTCOutboundRTPStreamStatsDict){
  if(!(this instanceof RTCOutboundRTPStreamStats))
    return new RTCOutboundRTPStreamStats(rTCOutboundRTPStreamStatsDict)

  rTCOutboundRTPStreamStatsDict = rTCOutboundRTPStreamStatsDict || {}

  // Check rTCOutboundRTPStreamStatsDict has the required fields
  // 
  // checkType('int64', 'rTCOutboundRTPStreamStatsDict.packetsSent', rTCOutboundRTPStreamStatsDict.packetsSent, {required: true});
  //  
  // checkType('int64', 'rTCOutboundRTPStreamStatsDict.bytesSent', rTCOutboundRTPStreamStatsDict.bytesSent, {required: true});
  //  
  // checkType('double', 'rTCOutboundRTPStreamStatsDict.targetBitrate', rTCOutboundRTPStreamStatsDict.targetBitrate, {required: true});
  //  
  // checkType('double', 'rTCOutboundRTPStreamStatsDict.roundTripTime', rTCOutboundRTPStreamStatsDict.roundTripTime, {required: true});
  //  

  // Init parent class
  RTCOutboundRTPStreamStats.super_.call(this, rTCOutboundRTPStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    packetsSent: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.packetsSent
    },
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.bytesSent
    },
    targetBitrate: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.targetBitrate
    },
    roundTripTime: {
      writable: true,
      enumerable: true,
      value: rTCOutboundRTPStreamStatsDict.roundTripTime
    }
  })
}
inherits(RTCOutboundRTPStreamStats, RTCRTPStreamStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCOutboundRTPStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCOutboundRTPStreamStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCOutboundRTPStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCOutboundRTPStreamStats} value
 */
function checkRTCOutboundRTPStreamStats(key, value)
{
  if(!(value instanceof RTCOutboundRTPStreamStats))
    throw ChecktypeError(key, RTCOutboundRTPStreamStats, value);
};


module.exports = RTCOutboundRTPStreamStats;

RTCOutboundRTPStreamStats.check = checkRTCOutboundRTPStreamStats;

},{"./RTCRTPStreamStats":69,"inherits":"inherits","kurento-client":"kurento-client"}],68:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to the peer connection.
 *
 * @constructor module:core/complexTypes.RTCPeerConnectionStats
 *
 * @property {external:int64} dataChannelsOpened
 *  Represents the number of unique datachannels opened.
 * @property {external:int64} dataChannelsClosed
 *  Represents the number of unique datachannels closed.

 * @extends module:core.RTCStats
 */
function RTCPeerConnectionStats(rTCPeerConnectionStatsDict){
  if(!(this instanceof RTCPeerConnectionStats))
    return new RTCPeerConnectionStats(rTCPeerConnectionStatsDict)

  rTCPeerConnectionStatsDict = rTCPeerConnectionStatsDict || {}

  // Check rTCPeerConnectionStatsDict has the required fields
  // 
  // checkType('int64', 'rTCPeerConnectionStatsDict.dataChannelsOpened', rTCPeerConnectionStatsDict.dataChannelsOpened, {required: true});
  //  
  // checkType('int64', 'rTCPeerConnectionStatsDict.dataChannelsClosed', rTCPeerConnectionStatsDict.dataChannelsClosed, {required: true});
  //  

  // Init parent class
  RTCPeerConnectionStats.super_.call(this, rTCPeerConnectionStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    dataChannelsOpened: {
      writable: true,
      enumerable: true,
      value: rTCPeerConnectionStatsDict.dataChannelsOpened
    },
    dataChannelsClosed: {
      writable: true,
      enumerable: true,
      value: rTCPeerConnectionStatsDict.dataChannelsClosed
    }
  })
}
inherits(RTCPeerConnectionStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCPeerConnectionStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCPeerConnectionStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCPeerConnectionStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCPeerConnectionStats} value
 */
function checkRTCPeerConnectionStats(key, value)
{
  if(!(value instanceof RTCPeerConnectionStats))
    throw ChecktypeError(key, RTCPeerConnectionStats, value);
};


module.exports = RTCPeerConnectionStats;

RTCPeerConnectionStats.check = checkRTCPeerConnectionStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],69:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics for the RTP stream
 *
 * @constructor module:core/complexTypes.RTCRTPStreamStats
 *
 * @property {external:String} ssrc
 *  The synchronized source SSRC
 * @property {external:String} associateStatsId
 *  The associateStatsId is used for looking up the corresponding (local/remote)
 * @property {external:Boolean} isRemote
 *  false indicates that the statistics are measured locally, while true 
 *  indicates that the measurements were done at the remote endpoint and 
 *  reported in an RTCP RR/XR.
 * @property {external:String} mediaTrackId
 *  Track identifier.
 * @property {external:String} transportId
 *  It is a unique identifier that is associated to the object that was 
 *  inspected to produce the RTCTransportStats associated with this RTP stream.
 * @property {external:String} codecId
 *  The codec identifier
 * @property {external:int64} firCount
 *  Count the total number of Full Intra Request (FIR) packets received by the 
 *  sender. This metric is only valid for video and is sent by receiver.
 * @property {external:int64} pliCount
 *  Count the total number of Packet Loss Indication (PLI) packets received by 
 *  the sender and is sent by receiver.
 * @property {external:int64} nackCount
 *  Count the total number of Negative ACKnowledgement (NACK) packets received 
 *  by the sender and is sent by receiver.
 * @property {external:int64} sliCount
 *  Count the total number of Slice Loss Indication (SLI) packets received by 
 *  the sender. This metric is only valid for video and is sent by receiver.
 * @property {external:int64} remb
 *  The Receiver Estimated Maximum Bitrate (REMB). This metric is only valid for
 * @property {external:int64} packetsLost
 *  Total number of RTP packets lost for this SSRC.
 * @property {external:double} fractionLost
 *  The fraction packet loss reported for this SSRC.

 * @extends module:core.RTCStats
 */
function RTCRTPStreamStats(rTCRTPStreamStatsDict){
  if(!(this instanceof RTCRTPStreamStats))
    return new RTCRTPStreamStats(rTCRTPStreamStatsDict)

  rTCRTPStreamStatsDict = rTCRTPStreamStatsDict || {}

  // Check rTCRTPStreamStatsDict has the required fields
  // 
  // checkType('String', 'rTCRTPStreamStatsDict.ssrc', rTCRTPStreamStatsDict.ssrc, {required: true});
  //  
  // checkType('String', 'rTCRTPStreamStatsDict.associateStatsId', rTCRTPStreamStatsDict.associateStatsId, {required: true});
  //  
  // checkType('boolean', 'rTCRTPStreamStatsDict.isRemote', rTCRTPStreamStatsDict.isRemote, {required: true});
  //  
  // checkType('String', 'rTCRTPStreamStatsDict.mediaTrackId', rTCRTPStreamStatsDict.mediaTrackId, {required: true});
  //  
  // checkType('String', 'rTCRTPStreamStatsDict.transportId', rTCRTPStreamStatsDict.transportId, {required: true});
  //  
  // checkType('String', 'rTCRTPStreamStatsDict.codecId', rTCRTPStreamStatsDict.codecId, {required: true});
  //  
  // checkType('int64', 'rTCRTPStreamStatsDict.firCount', rTCRTPStreamStatsDict.firCount, {required: true});
  //  
  // checkType('int64', 'rTCRTPStreamStatsDict.pliCount', rTCRTPStreamStatsDict.pliCount, {required: true});
  //  
  // checkType('int64', 'rTCRTPStreamStatsDict.nackCount', rTCRTPStreamStatsDict.nackCount, {required: true});
  //  
  // checkType('int64', 'rTCRTPStreamStatsDict.sliCount', rTCRTPStreamStatsDict.sliCount, {required: true});
  //  
  // checkType('int64', 'rTCRTPStreamStatsDict.remb', rTCRTPStreamStatsDict.remb, {required: true});
  //  
  // checkType('int64', 'rTCRTPStreamStatsDict.packetsLost', rTCRTPStreamStatsDict.packetsLost, {required: true});
  //  
  // checkType('double', 'rTCRTPStreamStatsDict.fractionLost', rTCRTPStreamStatsDict.fractionLost, {required: true});
  //  

  // Init parent class
  RTCRTPStreamStats.super_.call(this, rTCRTPStreamStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    ssrc: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.ssrc
    },
    associateStatsId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.associateStatsId
    },
    isRemote: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.isRemote
    },
    mediaTrackId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.mediaTrackId
    },
    transportId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.transportId
    },
    codecId: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.codecId
    },
    firCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.firCount
    },
    pliCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.pliCount
    },
    nackCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.nackCount
    },
    sliCount: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.sliCount
    },
    remb: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.remb
    },
    packetsLost: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.packetsLost
    },
    fractionLost: {
      writable: true,
      enumerable: true,
      value: rTCRTPStreamStatsDict.fractionLost
    }
  })
}
inherits(RTCRTPStreamStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCRTPStreamStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCRTPStreamStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCRTPStreamStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCRTPStreamStats} value
 */
function checkRTCRTPStreamStats(key, value)
{
  if(!(value instanceof RTCRTPStreamStats))
    throw ChecktypeError(key, RTCRTPStreamStats, value);
};


module.exports = RTCRTPStreamStats;

RTCRTPStreamStats.check = checkRTCRTPStreamStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],70:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var Stats = require('./Stats');


/**
 * An RTCStats dictionary represents the stats gathered.
 *
 * @constructor module:core/complexTypes.RTCStats
 *

 * @extends module:core.Stats
 */
function RTCStats(rTCStatsDict){
  if(!(this instanceof RTCStats))
    return new RTCStats(rTCStatsDict)

  rTCStatsDict = rTCStatsDict || {}

  // Check rTCStatsDict has the required fields
  // 

  // Init parent class
  RTCStats.super_.call(this, rTCStatsDict)

  // Set object properties
  Object.defineProperties(this, {
  })
}
inherits(RTCStats, Stats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStats} value
 */
function checkRTCStats(key, value)
{
  if(!(value instanceof RTCStats))
    throw ChecktypeError(key, RTCStats, value);
};


module.exports = RTCStats;

RTCStats.check = checkRTCStats;

},{"./Stats":77,"inherits":"inherits","kurento-client":"kurento-client"}],71:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Represents the state of the checklist for the local and remote candidates in 
 * a pair.
 *
 * @typedef core/complexTypes.RTCStatsIceCandidatePairState
 *
 * @type {(frozen|waiting|inprogress|failed|succeeded|cancelled)}
 */

/**
 * Checker for {@link module:core/complexTypes.RTCStatsIceCandidatePairState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStatsIceCandidatePairState} value
 */
function checkRTCStatsIceCandidatePairState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('frozen|waiting|inprogress|failed|succeeded|cancelled'))
    throw SyntaxError(key+' param is not one of [frozen|waiting|inprogress|failed|succeeded|cancelled] ('+value+')');
};


module.exports = checkRTCStatsIceCandidatePairState;

},{"kurento-client":"kurento-client"}],72:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Types of candidates
 *
 * @typedef core/complexTypes.RTCStatsIceCandidateType
 *
 * @type {(host|serverreflexive|peerreflexive|relayed)}
 */

/**
 * Checker for {@link module:core/complexTypes.RTCStatsIceCandidateType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCStatsIceCandidateType} value
 */
function checkRTCStatsIceCandidateType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('host|serverreflexive|peerreflexive|relayed'))
    throw SyntaxError(key+' param is not one of [host|serverreflexive|peerreflexive|relayed] ('+value+')');
};


module.exports = checkRTCStatsIceCandidateType;

},{"kurento-client":"kurento-client"}],73:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var RTCStats = require('./RTCStats');


/**
 * Statistics related to RTC data channels.
 *
 * @constructor module:core/complexTypes.RTCTransportStats
 *
 * @property {external:int64} bytesSent
 *  Represents the total number of payload bytes sent on this PeerConnection, 
 *  i.e., not including headers or padding.
 * @property {external:int64} bytesReceived
 *  Represents the total number of bytes received on this PeerConnection, i.e., 
 *  not including headers or padding.
 * @property {external:String} rtcpTransportStatsId
 *  If RTP and RTCP are not multiplexed, this is the id of the transport that 
 *  gives stats for the RTCP component, and this record has only the RTP 
 *  component stats.
 * @property {external:Boolean} activeConnection
 *  Set to true when transport is active.
 * @property {external:String} selectedCandidatePairId
 *  It is a unique identifier that is associated to the object that was 
 *  inspected to produce the RTCIceCandidatePairStats associated with this 
 *  transport.
 * @property {external:String} localCertificateId
 *  For components where DTLS is negotiated, give local certificate.
 * @property {external:String} remoteCertificateId
 *  For components where DTLS is negotiated, give remote certificate.

 * @extends module:core.RTCStats
 */
function RTCTransportStats(rTCTransportStatsDict){
  if(!(this instanceof RTCTransportStats))
    return new RTCTransportStats(rTCTransportStatsDict)

  rTCTransportStatsDict = rTCTransportStatsDict || {}

  // Check rTCTransportStatsDict has the required fields
  // 
  // checkType('int64', 'rTCTransportStatsDict.bytesSent', rTCTransportStatsDict.bytesSent, {required: true});
  //  
  // checkType('int64', 'rTCTransportStatsDict.bytesReceived', rTCTransportStatsDict.bytesReceived, {required: true});
  //  
  // checkType('String', 'rTCTransportStatsDict.rtcpTransportStatsId', rTCTransportStatsDict.rtcpTransportStatsId, {required: true});
  //  
  // checkType('boolean', 'rTCTransportStatsDict.activeConnection', rTCTransportStatsDict.activeConnection, {required: true});
  //  
  // checkType('String', 'rTCTransportStatsDict.selectedCandidatePairId', rTCTransportStatsDict.selectedCandidatePairId, {required: true});
  //  
  // checkType('String', 'rTCTransportStatsDict.localCertificateId', rTCTransportStatsDict.localCertificateId, {required: true});
  //  
  // checkType('String', 'rTCTransportStatsDict.remoteCertificateId', rTCTransportStatsDict.remoteCertificateId, {required: true});
  //  

  // Init parent class
  RTCTransportStats.super_.call(this, rTCTransportStatsDict)

  // Set object properties
  Object.defineProperties(this, {
    bytesSent: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.bytesSent
    },
    bytesReceived: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.bytesReceived
    },
    rtcpTransportStatsId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.rtcpTransportStatsId
    },
    activeConnection: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.activeConnection
    },
    selectedCandidatePairId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.selectedCandidatePairId
    },
    localCertificateId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.localCertificateId
    },
    remoteCertificateId: {
      writable: true,
      enumerable: true,
      value: rTCTransportStatsDict.remoteCertificateId
    }
  })
}
inherits(RTCTransportStats, RTCStats)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RTCTransportStats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RTCTransportStats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RTCTransportStats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RTCTransportStats} value
 */
function checkRTCTransportStats(key, value)
{
  if(!(value instanceof RTCTransportStats))
    throw ChecktypeError(key, RTCTransportStats, value);
};


module.exports = RTCTransportStats;

RTCTransportStats.check = checkRTCTransportStats;

},{"./RTCStats":70,"inherits":"inherits","kurento-client":"kurento-client"}],74:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Defines values for parameters of congestion control
 *
 * @constructor module:core/complexTypes.RembParams
 *
 * @property {external:Integer} packetsRecvIntervalTop
 *  Size of the RTP packets history to smooth fraction-lost.
 *  Units: num of packets
 * @property {external:Number} exponentialFactor
 *  Factor used to increase exponentially the next REMB when it is below the 
 *  threshold.
 *  REMB[i+1] = REMB[i] * (1 + exponentialFactor)
 * @property {external:Integer} linealFactorMin
 *  Set the min of the factor used to increase linearly the next REMB when it is
 *  Units: bps (bits per second).
 *  REMB[i+1] = REMB[i] + MIN (linealFactorMin, linealFactor)
 * @property {external:Number} linealFactorGrade
 *  Determine the value of the next linearFactor based on the threshold and the 
 *  current REMB. Taking into account that the frequency of updating is 500ms, 
 *  the default value makes that the last REMB is reached in 60secs.
 *  linealFactor = (REMB - TH) / linealFactorGrade
 * @property {external:Number} decrementFactor
 *  Determine how much is decreased the current REMB when too losses are 
 *  detected.
 *  REMB[i+1] = REMB[i] * decrementFactor
 * @property {external:Number} thresholdFactor
 *  Determine the next threshold (TH) when too losses are detected.
 *  TH[i+1] = REMB[i] * thresholdFactor
 * @property {external:Integer} upLosses
 *  Max fraction-lost to no determine too losses. This value is the denominator 
 *  of the fraction N/256, so the default value is about 4% of losses (12/256)
 * @property {external:Integer} rembOnConnect
 *  REMB propagated upstream when video sending is started in a new connected 
 *  endpoint.
 *    Unit: bps(bits per second)
 */
function RembParams(rembParamsDict){
  if(!(this instanceof RembParams))
    return new RembParams(rembParamsDict)

  rembParamsDict = rembParamsDict || {}

  // Check rembParamsDict has the required fields
  // 
  // checkType('int', 'rembParamsDict.packetsRecvIntervalTop', rembParamsDict.packetsRecvIntervalTop);
  //  
  // checkType('float', 'rembParamsDict.exponentialFactor', rembParamsDict.exponentialFactor);
  //  
  // checkType('int', 'rembParamsDict.linealFactorMin', rembParamsDict.linealFactorMin);
  //  
  // checkType('float', 'rembParamsDict.linealFactorGrade', rembParamsDict.linealFactorGrade);
  //  
  // checkType('float', 'rembParamsDict.decrementFactor', rembParamsDict.decrementFactor);
  //  
  // checkType('float', 'rembParamsDict.thresholdFactor', rembParamsDict.thresholdFactor);
  //  
  // checkType('int', 'rembParamsDict.upLosses', rembParamsDict.upLosses);
  //  
  // checkType('int', 'rembParamsDict.rembOnConnect', rembParamsDict.rembOnConnect);
  //  

  // Init parent class
  RembParams.super_.call(this, rembParamsDict)

  // Set object properties
  Object.defineProperties(this, {
    packetsRecvIntervalTop: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.packetsRecvIntervalTop
    },
    exponentialFactor: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.exponentialFactor
    },
    linealFactorMin: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.linealFactorMin
    },
    linealFactorGrade: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.linealFactorGrade
    },
    decrementFactor: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.decrementFactor
    },
    thresholdFactor: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.thresholdFactor
    },
    upLosses: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.upLosses
    },
    rembOnConnect: {
      writable: true,
      enumerable: true,
      value: rembParamsDict.rembOnConnect
    }
  })
}
inherits(RembParams, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(RembParams.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "RembParams"
  }
})

/**
 * Checker for {@link module:core/complexTypes.RembParams}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.RembParams} value
 */
function checkRembParams(key, value)
{
  if(!(value instanceof RembParams))
    throw ChecktypeError(key, RembParams, value);
};


module.exports = RembParams;

RembParams.check = checkRembParams;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],75:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Description of the mediaserver
 *
 * @constructor module:core/complexTypes.ServerInfo
 *
 * @property {external:String} version
 *  MediaServer version
 * @property {module:core/complexTypes.ModuleInfo} modules
 *  Descriptor of all modules loaded by the server
 * @property {module:core/complexTypes.ServerType} type
 *  Describes the type of mediaserver
 * @property {external:String} capabilities
 *  Describes the capabilities that this server supports
 */
function ServerInfo(serverInfoDict){
  if(!(this instanceof ServerInfo))
    return new ServerInfo(serverInfoDict)

  serverInfoDict = serverInfoDict || {}

  // Check serverInfoDict has the required fields
  // 
  // checkType('String', 'serverInfoDict.version', serverInfoDict.version, {required: true});
  //  
  // checkType('ModuleInfo', 'serverInfoDict.modules', serverInfoDict.modules, {isArray: true, required: true});
  //  
  // checkType('ServerType', 'serverInfoDict.type', serverInfoDict.type, {required: true});
  //  
  // checkType('String', 'serverInfoDict.capabilities', serverInfoDict.capabilities, {isArray: true, required: true});
  //  

  // Init parent class
  ServerInfo.super_.call(this, serverInfoDict)

  // Set object properties
  Object.defineProperties(this, {
    version: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.version
    },
    modules: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.modules
    },
    type: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.type
    },
    capabilities: {
      writable: true,
      enumerable: true,
      value: serverInfoDict.capabilities
    }
  })
}
inherits(ServerInfo, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(ServerInfo.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "ServerInfo"
  }
})

/**
 * Checker for {@link module:core/complexTypes.ServerInfo}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ServerInfo} value
 */
function checkServerInfo(key, value)
{
  if(!(value instanceof ServerInfo))
    throw ChecktypeError(key, ServerInfo, value);
};


module.exports = ServerInfo;

ServerInfo.check = checkServerInfo;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],76:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Indicates if the server is a real media server or a proxy
 *
 * @typedef core/complexTypes.ServerType
 *
 * @type {(KMS|KCS)}
 */

/**
 * Checker for {@link module:core/complexTypes.ServerType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.ServerType} value
 */
function checkServerType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('KMS|KCS'))
    throw SyntaxError(key+' param is not one of [KMS|KCS] ('+value+')');
};


module.exports = checkServerType;

},{"kurento-client":"kurento-client"}],77:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * A dictionary that represents the stats gathered.
 *
 * @constructor module:core/complexTypes.Stats
 *
 * @property {external:String} id
 *  A unique id that is associated with the object that was inspected to produce
 * @property {module:core/complexTypes.StatsType} type
 *  The type of this object.
 * @property {external:double} timestamp
 *  [DEPRECATED: Use timestampMillis] The timestamp associated with this object:
 * @property {external:int64} timestampMillis
 *  The timestamp associated with this event: Milliseconds elapsed since the 
 *  UNIX Epoch (Jan 1, 1970, UTC).
 */
function Stats(statsDict){
  if(!(this instanceof Stats))
    return new Stats(statsDict)

  statsDict = statsDict || {}

  // Check statsDict has the required fields
  // 
  // checkType('String', 'statsDict.id', statsDict.id, {required: true});
  //  
  // checkType('StatsType', 'statsDict.type', statsDict.type, {required: true});
  //  
  // checkType('double', 'statsDict.timestamp', statsDict.timestamp, {required: true});
  //  
  // checkType('int64', 'statsDict.timestampMillis', statsDict.timestampMillis, {required: true});
  //  

  // Init parent class
  Stats.super_.call(this, statsDict)

  // Set object properties
  Object.defineProperties(this, {
    id: {
      writable: true,
      enumerable: true,
      value: statsDict.id
    },
    type: {
      writable: true,
      enumerable: true,
      value: statsDict.type
    },
    timestamp: {
      writable: true,
      enumerable: true,
      value: statsDict.timestamp
    },
    timestampMillis: {
      writable: true,
      enumerable: true,
      value: statsDict.timestampMillis
    }
  })
}
inherits(Stats, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(Stats.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "Stats"
  }
})

/**
 * Checker for {@link module:core/complexTypes.Stats}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.Stats} value
 */
function checkStats(key, value)
{
  if(!(value instanceof Stats))
    throw ChecktypeError(key, Stats, value);
};


module.exports = Stats;

Stats.check = checkStats;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],78:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * The type of the object.
 *
 * @typedef core/complexTypes.StatsType
 *
 * @type {(inboundrtp|outboundrtp|session|datachannel|track|transport|candidatepair|localcandidate|remotecandidate|element|endpoint)}
 */

/**
 * Checker for {@link module:core/complexTypes.StatsType}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.StatsType} value
 */
function checkStatsType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('inboundrtp|outboundrtp|session|datachannel|track|transport|candidatepair|localcandidate|remotecandidate|element|endpoint'))
    throw SyntaxError(key+' param is not one of [inboundrtp|outboundrtp|session|datachannel|track|transport|candidatepair|localcandidate|remotecandidate|element|endpoint] ('+value+')');
};


module.exports = checkStatsType;

},{"kurento-client":"kurento-client"}],79:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Pair key-value with info about a MediaObject
 *
 * @constructor module:core/complexTypes.Tag
 *
 * @property {external:String} key
 *  Tag key
 * @property {external:String} value
 *  Tag Value
 */
function Tag(tagDict){
  if(!(this instanceof Tag))
    return new Tag(tagDict)

  tagDict = tagDict || {}

  // Check tagDict has the required fields
  // 
  // checkType('String', 'tagDict.key', tagDict.key, {required: true});
  //  
  // checkType('String', 'tagDict.value', tagDict.value, {required: true});
  //  

  // Init parent class
  Tag.super_.call(this, tagDict)

  // Set object properties
  Object.defineProperties(this, {
    key: {
      writable: true,
      enumerable: true,
      value: tagDict.key
    },
    value: {
      writable: true,
      enumerable: true,
      value: tagDict.value
    }
  })
}
inherits(Tag, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(Tag.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "Tag"
  }
})

/**
 * Checker for {@link module:core/complexTypes.Tag}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.Tag} value
 */
function checkTag(key, value)
{
  if(!(value instanceof Tag))
    throw ChecktypeError(key, Tag, value);
};


module.exports = Tag;

Tag.check = checkTag;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],80:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * State of the endpoint
 *
 * @typedef core/complexTypes.UriEndpointState
 *
 * @type {(STOP|START|PAUSE)}
 */

/**
 * Checker for {@link module:core/complexTypes.UriEndpointState}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.UriEndpointState} value
 */
function checkUriEndpointState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('STOP|START|PAUSE'))
    throw SyntaxError(key+' param is not one of [STOP|START|PAUSE] ('+value+')');
};


module.exports = checkUriEndpointState;

},{"kurento-client":"kurento-client"}],81:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('./ComplexType');


/**
 * Format for video media
 *
 * @constructor module:core/complexTypes.VideoCaps
 *
 * @property {module:core/complexTypes.VideoCodec} codec
 *  Video codec
 * @property {module:core/complexTypes.Fraction} framerate
 *  Framerate
 */
function VideoCaps(videoCapsDict){
  if(!(this instanceof VideoCaps))
    return new VideoCaps(videoCapsDict)

  videoCapsDict = videoCapsDict || {}

  // Check videoCapsDict has the required fields
  // 
  // checkType('VideoCodec', 'videoCapsDict.codec', videoCapsDict.codec, {required: true});
  //  
  // checkType('Fraction', 'videoCapsDict.framerate', videoCapsDict.framerate, {required: true});
  //  

  // Init parent class
  VideoCaps.super_.call(this, videoCapsDict)

  // Set object properties
  Object.defineProperties(this, {
    codec: {
      writable: true,
      enumerable: true,
      value: videoCapsDict.codec
    },
    framerate: {
      writable: true,
      enumerable: true,
      value: videoCapsDict.framerate
    }
  })
}
inherits(VideoCaps, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(VideoCaps.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "VideoCaps"
  }
})

/**
 * Checker for {@link module:core/complexTypes.VideoCaps}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.VideoCaps} value
 */
function checkVideoCaps(key, value)
{
  if(!(value instanceof VideoCaps))
    throw ChecktypeError(key, VideoCaps, value);
};


module.exports = VideoCaps;

VideoCaps.check = checkVideoCaps;

},{"./ComplexType":44,"inherits":"inherits","kurento-client":"kurento-client"}],82:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Codec used for transmission of video.
 *
 * @typedef core/complexTypes.VideoCodec
 *
 * @type {(VP8|H264|RAW)}
 */

/**
 * Checker for {@link module:core/complexTypes.VideoCodec}
 *
 * @memberof module:core/complexTypes
 *
 * @param {external:String} key
 * @param {module:core/complexTypes.VideoCodec} value
 */
function checkVideoCodec(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('VP8|H264|RAW'))
    throw SyntaxError(key+' param is not one of [VP8|H264|RAW] ('+value+')');
};


module.exports = checkVideoCodec;

},{"kurento-client":"kurento-client"}],83:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module core/complexTypes
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

var ComplexType = require('./ComplexType');

var AudioCaps = require('./AudioCaps');
var AudioCodec = require('./AudioCodec');
var CodecConfiguration = require('./CodecConfiguration');
var ConnectionState = require('./ConnectionState');
var ElementConnectionData = require('./ElementConnectionData');
var ElementStats = require('./ElementStats');
var EndpointStats = require('./EndpointStats');
var FilterType = require('./FilterType');
var Fraction = require('./Fraction');
var GstreamerDotDetails = require('./GstreamerDotDetails');
var MediaFlowState = require('./MediaFlowState');
var MediaLatencyStat = require('./MediaLatencyStat');
var MediaState = require('./MediaState');
var MediaTranscodingState = require('./MediaTranscodingState');
var MediaType = require('./MediaType');
var ModuleInfo = require('./ModuleInfo');
var RembParams = require('./RembParams');
var RTCCertificateStats = require('./RTCCertificateStats');
var RTCCodec = require('./RTCCodec');
var RTCDataChannelState = require('./RTCDataChannelState');
var RTCDataChannelStats = require('./RTCDataChannelStats');
var RTCIceCandidateAttributes = require('./RTCIceCandidateAttributes');
var RTCIceCandidatePairStats = require('./RTCIceCandidatePairStats');
var RTCInboundRTPStreamStats = require('./RTCInboundRTPStreamStats');
var RTCMediaStreamStats = require('./RTCMediaStreamStats');
var RTCMediaStreamTrackStats = require('./RTCMediaStreamTrackStats');
var RTCOutboundRTPStreamStats = require('./RTCOutboundRTPStreamStats');
var RTCPeerConnectionStats = require('./RTCPeerConnectionStats');
var RTCRTPStreamStats = require('./RTCRTPStreamStats');
var RTCStats = require('./RTCStats');
var RTCStatsIceCandidatePairState = require('./RTCStatsIceCandidatePairState');
var RTCStatsIceCandidateType = require('./RTCStatsIceCandidateType');
var RTCTransportStats = require('./RTCTransportStats');
var ServerInfo = require('./ServerInfo');
var ServerType = require('./ServerType');
var Stats = require('./Stats');
var StatsType = require('./StatsType');
var Tag = require('./Tag');
var UriEndpointState = require('./UriEndpointState');
var VideoCaps = require('./VideoCaps');
var VideoCodec = require('./VideoCodec');


exports.ComplexType = ComplexType;

exports.AudioCaps = AudioCaps;
exports.AudioCodec = AudioCodec;
exports.CodecConfiguration = CodecConfiguration;
exports.ConnectionState = ConnectionState;
exports.ElementConnectionData = ElementConnectionData;
exports.ElementStats = ElementStats;
exports.EndpointStats = EndpointStats;
exports.FilterType = FilterType;
exports.Fraction = Fraction;
exports.GstreamerDotDetails = GstreamerDotDetails;
exports.MediaFlowState = MediaFlowState;
exports.MediaLatencyStat = MediaLatencyStat;
exports.MediaState = MediaState;
exports.MediaTranscodingState = MediaTranscodingState;
exports.MediaType = MediaType;
exports.ModuleInfo = ModuleInfo;
exports.RembParams = RembParams;
exports.RTCCertificateStats = RTCCertificateStats;
exports.RTCCodec = RTCCodec;
exports.RTCDataChannelState = RTCDataChannelState;
exports.RTCDataChannelStats = RTCDataChannelStats;
exports.RTCIceCandidateAttributes = RTCIceCandidateAttributes;
exports.RTCIceCandidatePairStats = RTCIceCandidatePairStats;
exports.RTCInboundRTPStreamStats = RTCInboundRTPStreamStats;
exports.RTCMediaStreamStats = RTCMediaStreamStats;
exports.RTCMediaStreamTrackStats = RTCMediaStreamTrackStats;
exports.RTCOutboundRTPStreamStats = RTCOutboundRTPStreamStats;
exports.RTCPeerConnectionStats = RTCPeerConnectionStats;
exports.RTCRTPStreamStats = RTCRTPStreamStats;
exports.RTCStats = RTCStats;
exports.RTCStatsIceCandidatePairState = RTCStatsIceCandidatePairState;
exports.RTCStatsIceCandidateType = RTCStatsIceCandidateType;
exports.RTCTransportStats = RTCTransportStats;
exports.ServerInfo = ServerInfo;
exports.ServerType = ServerType;
exports.Stats = Stats;
exports.StatsType = StatsType;
exports.Tag = Tag;
exports.UriEndpointState = UriEndpointState;
exports.VideoCaps = VideoCaps;
exports.VideoCodec = VideoCodec;

},{"./AudioCaps":41,"./AudioCodec":42,"./CodecConfiguration":43,"./ComplexType":44,"./ConnectionState":45,"./ElementConnectionData":46,"./ElementStats":47,"./EndpointStats":48,"./FilterType":49,"./Fraction":50,"./GstreamerDotDetails":51,"./MediaFlowState":52,"./MediaLatencyStat":53,"./MediaState":54,"./MediaTranscodingState":55,"./MediaType":56,"./ModuleInfo":57,"./RTCCertificateStats":58,"./RTCCodec":59,"./RTCDataChannelState":60,"./RTCDataChannelStats":61,"./RTCIceCandidateAttributes":62,"./RTCIceCandidatePairStats":63,"./RTCInboundRTPStreamStats":64,"./RTCMediaStreamStats":65,"./RTCMediaStreamTrackStats":66,"./RTCOutboundRTPStreamStats":67,"./RTCPeerConnectionStats":68,"./RTCRTPStreamStats":69,"./RTCStats":70,"./RTCStatsIceCandidatePairState":71,"./RTCStatsIceCandidateType":72,"./RTCTransportStats":73,"./RembParams":74,"./ServerInfo":75,"./ServerType":76,"./Stats":77,"./StatsType":78,"./Tag":79,"./UriEndpointState":80,"./VideoCaps":81,"./VideoCodec":82}],84:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create for the given pipeline
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that mixes the {@link 
 *  module:elements.AlphaBlending#MediaType.AUDIO} stream of its connected 
 *  sources and constructs one output with {@link 
 *  module:elements.AlphaBlending#MediaType.VIDEO} streams of its connected 
 *  sources into its sink
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.AlphaBlending
 */
function AlphaBlending(){
  AlphaBlending.super_.call(this);
};
inherits(AlphaBlending, Hub);


//
// Public methods
//

/**
 * Sets the source port that will be the master entry to the mixer
 *
 * @alias module:elements.AlphaBlending.setMaster
 *
 * @param {module:core.HubPort} source
 *  The reference to the HubPort setting as master port
 *
 * @param {external:Integer} zOrder
 *  The order in z to draw the master image
 *
 * @param {module:elements.AlphaBlending~setMasterCallback} [callback]
 *
 * @return {external:Promise}
 */
AlphaBlending.prototype.setMaster = function(source, zOrder, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('HubPort', 'source', source, {required: true});
  checkType('int', 'zOrder', zOrder, {required: true});

  var params = {
    source: source,
    zOrder: zOrder
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setMaster', params, callback), this)
};
/**
 * @callback module:elements.AlphaBlending~setMasterCallback
 * @param {external:Error} error
 */

/**
 * Configure the blending mode of one port.
 *
 * @alias module:elements.AlphaBlending.setPortProperties
 *
 * @param {external:Number} relativeX
 *  The x position relative to the master port. Values from 0 to 1 are accepted.
 *
 * @param {external:Number} relativeY
 *  The y position relative to the master port. Values from 0 to 1 are accepted.
 *
 * @param {external:Integer} zOrder
 *  The order in z to draw the images. The greatest value of z is in the top.
 *
 * @param {external:Number} relativeWidth
 *  The image width relative to the master port width. Values from 0 to 1 are 
 *  accepted.
 *
 * @param {external:Number} relativeHeight
 *  The image height relative to the master port height. Values from 0 to 1 are 
 *  accepted.
 *
 * @param {module:core.HubPort} port
 *  The reference to the confingured port.
 *
 * @param {module:elements.AlphaBlending~setPortPropertiesCallback} [callback]
 *
 * @return {external:Promise}
 */
AlphaBlending.prototype.setPortProperties = function(relativeX, relativeY, zOrder, relativeWidth, relativeHeight, port, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('float', 'relativeX', relativeX, {required: true});
  checkType('float', 'relativeY', relativeY, {required: true});
  checkType('int', 'zOrder', zOrder, {required: true});
  checkType('float', 'relativeWidth', relativeWidth, {required: true});
  checkType('float', 'relativeHeight', relativeHeight, {required: true});
  checkType('HubPort', 'port', port, {required: true});

  var params = {
    relativeX: relativeX,
    relativeY: relativeY,
    zOrder: zOrder,
    relativeWidth: relativeWidth,
    relativeHeight: relativeHeight,
    port: port
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setPortProperties', params, callback), this)
};
/**
 * @callback module:elements.AlphaBlending~setPortPropertiesCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.AlphaBlending.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher 
 *  belongs
 */
AlphaBlending.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:elements.AlphaBlending.events
 *
 * @extends module:core/abstracts.Hub.events
 */
AlphaBlending.events = Hub.events;


/**
 * Checker for {@link module:elements.AlphaBlending}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.AlphaBlending} value
 */
function checkAlphaBlending(key, value)
{
  if(!(value instanceof AlphaBlending))
    throw ChecktypeError(key, AlphaBlending, value);
};


module.exports = AlphaBlending;

AlphaBlending.check = checkAlphaBlending;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],85:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Hub = require('kurento-client-core').abstracts.Hub;


/**
 * Create for the given pipeline
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that mixes the {@link 
 *  module:elements.Composite#MediaType.AUDIO} stream of its connected sources 
 *  and constructs a grid with the {@link 
 *  module:elements.Composite#MediaType.VIDEO} streams of its connected sources 
 *  into its sink
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.Composite
 */
function Composite(){
  Composite.super_.call(this);
};
inherits(Composite, Hub);


/**
 * @alias module:elements.Composite.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher 
 *  belongs
 */
Composite.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:elements.Composite.events
 *
 * @extends module:core/abstracts.Hub.events
 */
Composite.events = Hub.events;


/**
 * Checker for {@link module:elements.Composite}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.Composite} value
 */
function checkComposite(key, value)
{
  if(!(value instanceof Composite))
    throw ChecktypeError(key, Composite, value);
};


module.exports = Composite;

Composite.check = checkComposite;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],86:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create a {@link module:elements.Dispatcher Dispatcher} belonging to the given
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that allows routing between 
 *  arbitrary port pairs
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.Dispatcher
 */
function Dispatcher(){
  Dispatcher.super_.call(this);
};
inherits(Dispatcher, Hub);


//
// Public methods
//

/**
 * Connects each corresponding {@link MediaType} of the given source port with 
 * the sink port.
 *
 * @alias module:elements.Dispatcher.connect
 *
 * @param {module:core.HubPort} source
 *  Source port to be connected
 *
 * @param {module:core.HubPort} sink
 *  Sink port to be connected
 *
 * @param {module:elements.Dispatcher~connectCallback} [callback]
 *
 * @return {external:Promise}
 */
Dispatcher.prototype.connect = function(source, sink, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('HubPort', 'source', source, {required: true});
  checkType('HubPort', 'sink', sink, {required: true});

  var params = {
    source: source,
    sink: sink
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'connect', params, callback), this)
};
/**
 * @callback module:elements.Dispatcher~connectCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.Dispatcher.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher 
 *  belongs
 */
Dispatcher.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:elements.Dispatcher.events
 *
 * @extends module:core/abstracts.Hub.events
 */
Dispatcher.events = Hub.events;


/**
 * Checker for {@link module:elements.Dispatcher}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.Dispatcher} value
 */
function checkDispatcher(key, value)
{
  if(!(value instanceof Dispatcher))
    throw ChecktypeError(key, Dispatcher, value);
};


module.exports = Dispatcher;

Dispatcher.check = checkDispatcher;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],87:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create a {@link module:elements.DispatcherOneToMany DispatcherOneToMany} 
 * belonging to the given pipeline.
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that sends a given source to all the
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.DispatcherOneToMany
 */
function DispatcherOneToMany(){
  DispatcherOneToMany.super_.call(this);
};
inherits(DispatcherOneToMany, Hub);


//
// Public methods
//

/**
 * Remove the source port and stop the media pipeline.
 *
 * @alias module:elements.DispatcherOneToMany.removeSource
 *
 * @param {module:elements.DispatcherOneToMany~removeSourceCallback} [callback]
 *
 * @return {external:Promise}
 */
DispatcherOneToMany.prototype.removeSource = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'removeSource', callback), this)
};
/**
 * @callback module:elements.DispatcherOneToMany~removeSourceCallback
 * @param {external:Error} error
 */

/**
 * Sets the source port that will be connected to the sinks of every {@link 
 * module:core.HubPort HubPort} of the dispatcher
 *
 * @alias module:elements.DispatcherOneToMany.setSource
 *
 * @param {module:core.HubPort} source
 *  source to be broadcasted
 *
 * @param {module:elements.DispatcherOneToMany~setSourceCallback} [callback]
 *
 * @return {external:Promise}
 */
DispatcherOneToMany.prototype.setSource = function(source, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('HubPort', 'source', source, {required: true});

  var params = {
    source: source
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setSource', params, callback), this)
};
/**
 * @callback module:elements.DispatcherOneToMany~setSourceCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.DispatcherOneToMany.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the dispatcher 
 *  belongs
 */
DispatcherOneToMany.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:elements.DispatcherOneToMany.events
 *
 * @extends module:core/abstracts.Hub.events
 */
DispatcherOneToMany.events = Hub.events;


/**
 * Checker for {@link module:elements.DispatcherOneToMany}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.DispatcherOneToMany} value
 */
function checkDispatcherOneToMany(key, value)
{
  if(!(value instanceof DispatcherOneToMany))
    throw ChecktypeError(key, DispatcherOneToMany, value);
};


module.exports = DispatcherOneToMany;

DispatcherOneToMany.check = checkDispatcherOneToMany;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],88:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var HttpEndpoint = require('./abstracts/HttpEndpoint');


/**
 * Builder for the {@link module:elements.HttpPostEndpoint HttpPostEndpoint}.
 *
 * @classdesc
 *  An {@link module:elements.HttpPostEndpoint HttpPostEndpoint} contains SINK 
 *  pads for AUDIO and VIDEO, which provide access to an HTTP file upload 
 *  function
 *     This type of endpoint provide unidirectional communications. Its 
 *     :rom:cls:`MediaSources <MediaSource>` are accessed through the <a 
 *     href="http://www.kurento.org/docs/current/glossary.html#term-http">HTTP</a>
 *
 * @extends module:elements/abstracts.HttpEndpoint
 *
 * @constructor module:elements.HttpPostEndpoint
 *
 * @fires {@link module:elements#event:EndOfStream EndOfStream}
 */
function HttpPostEndpoint(){
  HttpPostEndpoint.super_.call(this);
};
inherits(HttpPostEndpoint, HttpEndpoint);


/**
 * @alias module:elements.HttpPostEndpoint.constructorParams
 *
 * @property {external:Integer} [disconnectionTimeout]
 *  This is the time that an http endpoint will wait for a reconnection, in case
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint 
 *  belongs
 *
 * @property {external:Boolean} [useEncodedMedia]
 *  configures the endpoint to use encoded media instead of raw media. If the 
 *  parameter is not set then the element uses raw media. Changing this 
 *  parameter could affect in a severe way to stability because key frames lost 
 *  will not be generated. Changing the media type does not affect to the result
 */
HttpPostEndpoint.constructorParams = {
  disconnectionTimeout: {
    type: 'int'  },
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  },
  useEncodedMedia: {
    type: 'boolean'  }
};

/**
 * @alias module:elements.HttpPostEndpoint.events
 *
 * @extends module:elements/abstracts.HttpEndpoint.events
 */
HttpPostEndpoint.events = HttpEndpoint.events.concat(['EndOfStream']);


/**
 * Checker for {@link module:elements.HttpPostEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.HttpPostEndpoint} value
 */
function checkHttpPostEndpoint(key, value)
{
  if(!(value instanceof HttpPostEndpoint))
    throw ChecktypeError(key, HttpPostEndpoint, value);
};


module.exports = HttpPostEndpoint;

HttpPostEndpoint.check = checkHttpPostEndpoint;

},{"./abstracts/HttpEndpoint":94,"inherits":"inherits","kurento-client":"kurento-client"}],89:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Hub = require('kurento-client-core').abstracts.Hub;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create a {@link module:elements.Mixer Mixer} belonging to the given pipeline.
 *
 * @classdesc
 *  A {@link module:core/abstracts.Hub Hub} that allows routing of video between
 *
 * @extends module:core/abstracts.Hub
 *
 * @constructor module:elements.Mixer
 */
function Mixer(){
  Mixer.super_.call(this);
};
inherits(Mixer, Hub);


//
// Public methods
//

/**
 * Connects each corresponding {@link MediaType} of the given source port with 
 * the sink port.
 *
 * @alias module:elements.Mixer.connect
 *
 * @param {external:MediaType} media
 *  The sort of media stream to be connected
 *
 * @param {module:core.HubPort} source
 *  Source port to be connected
 *
 * @param {module:core.HubPort} sink
 *  Sink port to be connected
 *
 * @param {module:elements.Mixer~connectCallback} [callback]
 *
 * @return {external:Promise}
 */
Mixer.prototype.connect = function(media, source, sink, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('MediaType', 'media', media, {required: true});
  checkType('HubPort', 'source', source, {required: true});
  checkType('HubPort', 'sink', sink, {required: true});

  var params = {
    media: media,
    source: source,
    sink: sink
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'connect', params, callback), this)
};
/**
 * @callback module:elements.Mixer~connectCallback
 * @param {external:Error} error
 */

/**
 * Disonnects each corresponding {@link MediaType} of the given source port from
 *
 * @alias module:elements.Mixer.disconnect
 *
 * @param {external:MediaType} media
 *  The sort of media stream to be disconnected
 *
 * @param {module:core.HubPort} source
 *  Audio source port to be disconnected
 *
 * @param {module:core.HubPort} sink
 *  Audio sink port to be disconnected
 *
 * @param {module:elements.Mixer~disconnectCallback} [callback]
 *
 * @return {external:Promise}
 */
Mixer.prototype.disconnect = function(media, source, sink, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('MediaType', 'media', media, {required: true});
  checkType('HubPort', 'source', source, {required: true});
  checkType('HubPort', 'sink', sink, {required: true});

  var params = {
    media: media,
    source: source,
    sink: sink
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'disconnect', params, callback), this)
};
/**
 * @callback module:elements.Mixer~disconnectCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.Mixer.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the Mixer 
 *  belongs
 */
Mixer.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:elements.Mixer.events
 *
 * @extends module:core/abstracts.Hub.events
 */
Mixer.events = Hub.events;


/**
 * Checker for {@link module:elements.Mixer}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.Mixer} value
 */
function checkMixer(key, value)
{
  if(!(value instanceof Mixer))
    throw ChecktypeError(key, Mixer, value);
};


module.exports = Mixer;

Mixer.check = checkMixer;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],90:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var UriEndpoint = require('kurento-client-core').abstracts.UriEndpoint;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create a PlayerEndpoint
 *
 * @classdesc
 *        <p>
 *        Retrieves content from seekable or non-seekable sources, and injects 
 *        them into <a 
 *        href="http://www.kurento.org/docs/current/glossary.html#term-kms">KMS</a>,
 *        <ul>
 *          <li>
 *            Files: Mounted in the local file system.
 *            <ul><li>file:///path/to/file</li></ul>
 *          </li>
 *          <li>
 *            RTSP: Those of IP cameras would be a good example.
 *            <ul>
 *              <li>rtsp://<server-ip></li>
 *              <li>rtsp://username:password@<server-ip></li>
 *            </ul>
 *          </li>
 *          <li>
 *            HTTP: Any file available in an HTTP server
 *            <ul>
 *              <li>http(s)://<server-ip>/path/to/file</li>
 *              <li>http(s)://username:password@<server-ip>/path/to/file</li>
 *            </ul>
 *          </li>
 *        </ul>
 *        </p>
 *        <p>
 *        For the player to stream the contents of the file, the server must 
 *        have access to the resource. In case of local files, the user running 
 *        the process must have read permissions over the file. For network 
 *        resources, the path to the resource must be accessible: IP and port 
 *        access not blocked, correct credentials, etc.The resource location 
 *        can’t be changed after the player is created, and a new player should 
 *        be created for streaming a different resource.
 *        </p>
 *        <p>
 *        The list of valid operations is
 *        <ul>
 *          <li>*play*: starts streaming media. If invoked after pause, it will 
 *          resume playback.</li>
 *          <li>*stop*: stops streaming media. If play is invoked afterwards, 
 *          the file will be streamed from the beginning.</li>
 *          <li>*pause*: pauses media streaming. Play must be invoked in order 
 *          to resume playback.</li>
 *          <li>*seek*: If the source supports “jumps” in the timeline, then the
 *            <ul>
 *              <li>*setPosition*: allows to set the position in the file.</li>
 *              <li>*getPosition*: returns the current position being 
 *              streamed.</li>
 *            </ul>
 *          </li>
 *        </ul>
 *        </p>
 *        <p>
 *        <h2>Events fired:</h2>
 *        <ul><li>EndOfStreamEvent: If the file is streamed 
 *        completely.</li></ul>
 *        </p>
 *
 * @extends module:core/abstracts.UriEndpoint
 *
 * @constructor module:elements.PlayerEndpoint
 *
 * @fires {@link module:elements#event:EndOfStream EndOfStream}
 */
function PlayerEndpoint(){
  PlayerEndpoint.super_.call(this);
};
inherits(PlayerEndpoint, UriEndpoint);


//
// Public properties
//

/**
 * Get or set the actual position of the video in ms. <hr/><b>Note</b> Setting 
 * the position only works for seekable videos
 *
 * @alias module:elements.PlayerEndpoint#getPosition
 *
 * @param {module:elements.PlayerEndpoint~getPositionCallback} [callback]
 *
 * @return {external:Promise}
 */
PlayerEndpoint.prototype.getPosition = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getPosition', callback), this)
};
/**
 * @callback module:elements.PlayerEndpoint~getPositionCallback
 * @param {external:Error} error
 * @param {external:int64} result
 */

/**
 * Get or set the actual position of the video in ms. <hr/><b>Note</b> Setting 
 * the position only works for seekable videos
 *
 * @alias module:elements.PlayerEndpoint#setPosition
 *
 * @param {external:int64} position
 * @param {module:elements.PlayerEndpoint~setPositionCallback} [callback]
 *
 * @return {external:Promise}
 */
PlayerEndpoint.prototype.setPosition = function(position, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int64', 'position', position, {required: true});

  var params = {
    position: position
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setPosition', params, callback), this)
};
/**
 * @callback module:elements.PlayerEndpoint~setPositionCallback
 * @param {external:Error} error
 */

/**
 * Returns info about the source being played
 *
 * @alias module:elements.PlayerEndpoint#getVideoInfo
 *
 * @param {module:elements.PlayerEndpoint~getVideoInfoCallback} [callback]
 *
 * @return {external:Promise}
 */
PlayerEndpoint.prototype.getVideoInfo = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getVideoInfo', callback), this)
};
/**
 * @callback module:elements.PlayerEndpoint~getVideoInfoCallback
 * @param {external:Error} error
 * @param {module:elements/complexTypes.VideoInfo} result
 */


//
// Public methods
//

/**
 * Starts reproducing the media, sending it to the :rom:cls:`MediaSource`. If 
 * the endpoint
 *           has been connected to other endpoints, those will start receiving 
 *           media.
 *
 * @alias module:elements.PlayerEndpoint.play
 *
 * @param {module:elements.PlayerEndpoint~playCallback} [callback]
 *
 * @return {external:Promise}
 */
PlayerEndpoint.prototype.play = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'play', callback), this)
};
/**
 * @callback module:elements.PlayerEndpoint~playCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.PlayerEndpoint.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  The {@link module:core.MediaPipeline MediaPipeline} this PlayerEndpoint 
 *  belongs to.
 *
 * @property {external:Integer} [networkCache]
 *  When using rtsp sources. Amount of ms to buffer
 *
 * @property {external:String} uri
 *  URI pointing to the video. It has to be accessible to the KMS process.
 *                <ul>
 *                  <li>Local resources: The user running the Kurento Media 
 *                  Server must have read permission over the file.</li>
 *                  <li>Remote resources: Must be accessible from the server 
 *                  where the media server is running.</li>
 *                </ul>
 *
 * @property {external:Boolean} [useEncodedMedia]
 *  use encoded instead of raw media. If the parameter is false then the element
 */
PlayerEndpoint.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  },
  networkCache: {
    type: 'int'  },
  uri: {
    type: 'String',
    required: true
  },
  useEncodedMedia: {
    type: 'boolean'  }
};

/**
 * @alias module:elements.PlayerEndpoint.events
 *
 * @extends module:core/abstracts.UriEndpoint.events
 */
PlayerEndpoint.events = UriEndpoint.events.concat(['EndOfStream']);


/**
 * Checker for {@link module:elements.PlayerEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.PlayerEndpoint} value
 */
function checkPlayerEndpoint(key, value)
{
  if(!(value instanceof PlayerEndpoint))
    throw ChecktypeError(key, PlayerEndpoint, value);
};


module.exports = PlayerEndpoint;

PlayerEndpoint.check = checkPlayerEndpoint;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],91:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var UriEndpoint = require('kurento-client-core').abstracts.UriEndpoint;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 *
 * @classdesc
 *  <p>
 *        Provides the functionality to store contents. The recorder can store 
 *        in local files or in a network resource. It receives a media stream 
 *        from another MediaElement (i.e. the source), and stores it in the 
 *        designated location.
 *        </p>
 *        <p>
 *        The following information has to be provided In order to create a 
 *        RecorderEndpoint, and can’t be changed afterwards:
 *        <ul>
 *          <li>
 *            URI of the resource where media will be stored. Following schemas 
 *            are supported:
 *            <ul>
 *              <li>
 *                Files: mounted in the local file system.
 *                <ul>
 *                  <li>file://<path-to-file></li>
 *                </ul>
 *              <li>
 *                HTTP: Requires the server to support method PUT
 *                <ul>
 *                  <li>
 *                    http(s)://<server-ip>/path/to/file
 *                  </li>
 *                  <li>
 *                    http(s)://username:password@<server-ip>/path/to/file
 *                  </li>
 *                </ul>
 *              </li>
 *            </ul>
 *          </li>
 *          <li>
 *            Relative URIs (with no schema) are supported. They are completed 
 *            prepending a default URI defined by property defaultPath. This 
 *            property allows using relative paths instead of absolute paths. If
 *          </li>
 *          <li>
 *            The media profile used to store the file. This will determine the 
 *            encoding. See below for more details about media profile
 *          </li>
 *          <li>
 *            Optionally, the user can select if the endpoint will stop 
 *            processing once the EndOfStream event is detected.
 *          </li>
 *        </ul>
 *        <p>
 *        </p>
 *        RecorderEndpoint requires access to the resource where stream is going
 *        <p>
 *        </p>
 *        The media profile is quite an important parameter, as it will 
 *        determine whether there is a transcodification or not. If the input 
 *        stream codec if not compatible with the selected media profile, the 
 *        media will be transcoded into a suitable format, before arriving at 
 *        the RecorderEndpoint's sink pad. This will result in a higher CPU load
 *        <ul>
 *          <li>WEBM: No transcodification will take place.</li>
 *          <li>MP4: The media server will have to transcode the media received 
 *          from VP8 to H264. This will raise the CPU load in the system.</li>
 *        </ul>
 *        <p>
 *        </p>
 *        Recording will start as soon as the user invokes the record method. 
 *        The recorder will then store, in the location indicated, the media 
 *        that the source is sending to the endpoint’s sink. If no media is 
 *        being received, or no endpoint has been connected, then the 
 *        destination will be empty. The recorder starts storing information 
 *        into the file as soon as it gets it.
 *        <p>
 *        </p>
 *        When another endpoint is connected to the recorder, by default both 
 *        AUDIO and VIDEO media types are expected, unless specified otherwise 
 *        when invoking the connect method. Failing to provide both types, will 
 *        result in teh recording buffering the received media: it won’t be 
 *        written to the file until the recording is stopped. This is due to the
 *        <p>
 *        </p>
 *        The source endpoint can be hot-swapped, while the recording is taking 
 *        place. The recorded file will then contain different feeds. When 
 *        switching video sources, if the new video has different size, the 
 *        recorder will retain the size of the previous source. If the source is
 *        <p>
 *        </p>
 *        It is recommended to start recording only after media arrives, either 
 *        to the endpoint that is the source of the media connected to the 
 *        recorder, to the recorder itself, or both. Users may use the 
 *        MediaFlowIn and MediaFlowOut events, and synchronise the recording 
 *        with the moment media comes in. In any case, nothing will be stored in
 *        <p>
 *        </p>
 *        Stopping the recording process is done through the stopAndWait method,
 *        </p>
 *
 * @extends module:core/abstracts.UriEndpoint
 *
 * @constructor module:elements.RecorderEndpoint
 *
 * @fires {@link module:elements#event:Paused Paused}
 * @fires {@link module:elements#event:Recording Recording}
 * @fires {@link module:elements#event:Stopped Stopped}
 */
function RecorderEndpoint(){
  RecorderEndpoint.super_.call(this);
};
inherits(RecorderEndpoint, UriEndpoint);


//
// Public methods
//

/**
 * Starts storing media received through the sink pad.
 *
 * @alias module:elements.RecorderEndpoint.record
 *
 * @param {module:elements.RecorderEndpoint~recordCallback} [callback]
 *
 * @return {external:Promise}
 */
RecorderEndpoint.prototype.record = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'record', callback), this)
};
/**
 * @callback module:elements.RecorderEndpoint~recordCallback
 * @param {external:Error} error
 */

/**
 * Stops recording and does not return until all the content has been written to
 *
 * @alias module:elements.RecorderEndpoint.stopAndWait
 *
 * @param {module:elements.RecorderEndpoint~stopAndWaitCallback} [callback]
 *
 * @return {external:Promise}
 */
RecorderEndpoint.prototype.stopAndWait = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'stopAndWait', callback), this)
};
/**
 * @callback module:elements.RecorderEndpoint~stopAndWaitCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.RecorderEndpoint.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint 
 *  belongs
 *
 * @property {module:elements/complexTypes.MediaProfileSpecType} [mediaProfile]
 *  Sets the media profile used for recording. If the profile is different than 
 *  the one being recieved at the sink pad, media will be trnascoded, resulting 
 *  in a higher CPU load. For instance, when recording a VP8 encoded video from 
 *  a WebRTC endpoint in MP4, the load is higher that when recording in WEBM.
 *
 * @property {external:Boolean} [stopOnEndOfStream]
 *  Forces the recorder endpoint to finish processing data when an <a 
 *  href="http://www.kurento.org/docs/current/glossary.html#term-eos">EOS</a> is
 *
 * @property {external:String} uri
 *  URI where the recording will be stored. It has to be accessible to the KMS 
 *  process.
 *                <ul>
 *                  <li>Local server resources: The user running the Kurento 
 *                  Media Server must have write permission over the file.</li>
 *                  <li>Network resources: Must be accessible from the server 
 *                  where the media server is running.</li>
 *                </ul>
 */
RecorderEndpoint.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  },
  mediaProfile: {
    type: 'kurento.MediaProfileSpecType'  },
  stopOnEndOfStream: {
    type: 'boolean'  },
  uri: {
    type: 'String',
    required: true
  }
};

/**
 * @alias module:elements.RecorderEndpoint.events
 *
 * @extends module:core/abstracts.UriEndpoint.events
 */
RecorderEndpoint.events = UriEndpoint.events.concat(['Paused', 'Recording', 'Stopped']);


/**
 * Checker for {@link module:elements.RecorderEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.RecorderEndpoint} value
 */
function checkRecorderEndpoint(key, value)
{
  if(!(value instanceof RecorderEndpoint))
    throw ChecktypeError(key, RecorderEndpoint, value);
};


module.exports = RecorderEndpoint;

RecorderEndpoint.check = checkRecorderEndpoint;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],92:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var BaseRtpEndpoint = require('kurento-client-core').abstracts.BaseRtpEndpoint;


/**
 * Builder for the {@link module:elements.RtpEndpoint RtpEndpoint}
 *
 * @classdesc
 *  Endpoint that provides bidirectional content delivery capabilities with 
 *  remote networked peers through RTP or SRTP protocol. An {@link 
 *  module:elements.RtpEndpoint RtpEndpoint} contains paired sink and source 
 *  :rom:cls:`MediaPad` for audio and video. This endpoint inherits from {@link 
 *  module:core/abstracts.BaseRtpEndpoint BaseRtpEndpoint}.
 *        </p>
 *        <p>
 *        In order to establish an RTP/SRTP communication, peers engage in an 
 *        SDP negotiation process, where one of the peers (the offerer) sends an
 *        <ul style='list-style-type:circle'>
 *          <li>
 *            As offerer: The negotiation process is initiated by the media 
 *            server
 *            <ul>
 *              <li>KMS generates the SDP offer through the generateOffer 
 *              method. This offer must then be sent to the remote peer (the 
 *              offeree) through the signaling channel, for processing.</li>
 *              <li>The remote peer process the Offer, and generates an Answer 
 *              to this offer. The Answer is sent back to the media server.</li>
 *              <li>Upon receiving the Answer, the endpoint must invoke the 
 *              processAnswer method.</li>
 *            </ul>
 *          </li>
 *          <li>
 *            As offeree: The negotiation process is initiated by the remote 
 *            peer
 *            <ul>
 *              <li>The remote peer, acting as offerer, generates an SDP offer 
 *              and sends it to the WebRTC endpoint in Kurento.</li>
 *              <li>The endpoint will process the Offer invoking the 
 *              processOffer method. The result of this method will be a string,
 *              <li>The SDP Answer must be sent back to the offerer, so it can 
 *              be processed.</li>
 *            </ul>
 *          </li>
 *        </ul>
 *        </p>
 *        <p>
 *        In case of unidirectional connections (i.e. only one peer is going to 
 *        send media), the process is more simple, as only the emitter needs to 
 *        process an SDP. On top of the information about media codecs and 
 *        types, the SDP must contain the IP of the remote peer, and the port 
 *        where it will be listening. This way, the SDP can be mangled without 
 *        needing to go through the exchange process, as the receiving peer does
 *        </p>
 *        <p>
 *        While there is no congestion control in this endpoint, the user can 
 *        set some bandwidth limits that will be used during the negotiation 
 *        process.
 *        The default bandwidth range of the endpoint is 100kbps-500kbps, but it
 *        <ul style='list-style-type:circle'>
 *          <li>
 *            Input bandwidth control mechanism: Configuration interval used to 
 *            inform remote peer the range of bitrates that can be pushed into 
 *            this RtpEndpoint object. These values are announced in the SDP.
 *            <ul>
 *              <li>
 *                setMaxVideoRecvBandwidth: sets Max bitrate limits expected for
 *              </li>
 *              <li>
 *                setMaxAudioRecvBandwidth: sets Max bitrate limits expected for
 *              </li>
 *            </ul>
 *          </li>
 *          <li>
 *            Output bandwidth control mechanism: Configuration interval used to
 *            <ul>
 *              <li>
 *                setMaxVideoSendBandwidth: sets Max bitrate limits for video 
 *                sent to remote peer.
 *              </li>
 *              <li>
 *                setMinVideoSendBandwidth: sets Min bitrate limits for audio 
 *                sent to remote peer.
 *              </li>
 *            </ul>
 *          </li>
 *        </ul>
 *        All bandwidth control parameters must be changed before the SDP 
 *        negotiation takes place, and can't be modified afterwards.
 *        TODO: What happens if the b=as tag form the SDP has a lower value than
 *        </p>
 *        <p>
 *        Having no congestion ocntrol implementation means that the bitrate 
 *        will remain constant. This is something to take into consideration 
 *        when setting upper limits for the output bandwidth, or the local 
 *        network connection can be overflooded.
 *        </p>
 *
 * @extends module:core/abstracts.BaseRtpEndpoint
 *
 * @constructor module:elements.RtpEndpoint
 *
 * @fires {@link module:elements#event:OnKeySoftLimit OnKeySoftLimit}
 */
function RtpEndpoint(){
  RtpEndpoint.super_.call(this);
};
inherits(RtpEndpoint, BaseRtpEndpoint);


/**
 * @alias module:elements.RtpEndpoint.constructorParams
 *
 * @property {module:elements/complexTypes.SDES} [crypto]
 *  SDES-type param. If present, this parameter indicates that the communication
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint 
 *  belongs
 *
 * @property {external:Boolean} [useIpv6]
 *  This configures the endpoint to use IPv6 instead of IPv4.
 */
RtpEndpoint.constructorParams = {
  crypto: {
    type: 'kurento.SDES'  },
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  },
  useIpv6: {
    type: 'boolean'  }
};

/**
 * @alias module:elements.RtpEndpoint.events
 *
 * @extends module:core/abstracts.BaseRtpEndpoint.events
 */
RtpEndpoint.events = BaseRtpEndpoint.events.concat(['OnKeySoftLimit']);


/**
 * Checker for {@link module:elements.RtpEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.RtpEndpoint} value
 */
function checkRtpEndpoint(key, value)
{
  if(!(value instanceof RtpEndpoint))
    throw ChecktypeError(key, RtpEndpoint, value);
};


module.exports = RtpEndpoint;

RtpEndpoint.check = checkRtpEndpoint;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],93:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var BaseRtpEndpoint = require('kurento-client-core').abstracts.BaseRtpEndpoint;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Builder for the {@link module:elements.WebRtcEndpoint WebRtcEndpoint}
 *
 * @classdesc
 *  <p>
 *        Control interface for Kurento WebRTC endpoint.
 *        </p>
 *        <p>
 *        This endpoint is one side of a peer-to-peer WebRTC communication, 
 *        being the other peer a WebRTC capable browser -using the 
 *        RTCPeerConnection API-, a native WebRTC app or even another Kurento 
 *        Media Server.
 *        </p>
 *        <p>
 *        In order to establish a WebRTC communication, peers engage in an SDP 
 *        negotiation process, where one of the peers (the offerer) sends an 
 *        offer, while the other peer (the offeree) responds with an answer. 
 *        This endpoint can function in both situations
 *        <ul>
 *          <li>
 *            As offerer: The negotiation process is initiated by the media 
 *            server
 *            <ul style='list-style-type:circle'>
 *              <li>KMS generates the SDP offer through the 
 *              <code>generateOffer</code> method. This <i>offer</i> must then 
 *              be sent to the remote peer (the offeree) through the signaling 
 *              channel, for processing.</li>
 *              <li>The remote peer process the <i>offer</i>, and generates an 
 *              <i>answer</i> to this <i>offer</i>. The <i>answer</i> is sent 
 *              back to the media server.</li>
 *              <li>Upon receiving the <i>answer</i>, the endpoint must invoke 
 *              the <code>processAnswer</code> method.</li>
 *            </ul>
 *          </li>
 *          <li>
 *            As offeree: The negotiation process is initiated by the remote 
 *            peer
 *            <ul>
 *              <li>The remote peer, acting as offerer, generates an SDP 
 *              <i>offer</i> and sends it to the WebRTC endpoint in 
 *              Kurento.</li>
 *              <li>The endpoint will process the <i>offer</i> invoking the 
 *              <code>processOffer</code> method. The result of this method will
 *              <li>The SDP <i>answer</i> must be sent back to the offerer, so 
 *              it can be processed.</li>
 *            </ul>
 *          </li>
 *        </ul>
 *        </p>
 *        <p>
 *        SDPs are sent without ICE candidates, following the Trickle ICE 
 *        optimization. Once the SDP negotiation is completed, both peers 
 *        proceed with the ICE discovery process, intended to set up a 
 *        bidirectional media connection. During this process, each peer
 *        <ul>
 *          <li>Discovers ICE candidates for itself, containing pairs of IPs and
 *          <li>ICE candidates are sent via the signaling channel as they are 
 *          discovered, to the remote peer for probing.</li>
 *          <li>ICE connectivity checks are run as soon as the new candidate 
 *          description, from the remote peer, is available.</li>
 *        </ul>
 *        Once a suitable pair of candidates (one for each peer) is discovered, 
 *        the media session can start. The harvesting process in Kurento, begins
 *        </p>
 *        <p>
 *        It's important to keep in mind that WebRTC connection is an 
 *        asynchronous process, when designing interactions between different 
 *        MediaElements. For example, it would be pointless to start recording 
 *        before media is flowing. In order to be notified of state changes, the
 *        <ul>
 *          <li>
 *            <code>IceComponentStateChange</code>: This event informs only 
 *            about changes in the ICE connection state. Possible values are:
 *            <ul style='list-style-type:circle'>
 *              <li><code>DISCONNECTED</code>: No activity scheduled</li>
 *              <li><code>GATHERING</code>: Gathering local candidates</li>
 *              <li><code>CONNECTING</code>: Establishing connectivity</li>
 *              <li><code>CONNECTED</code>: At least one working candidate 
 *              pair</li>
 *              <li><code>READY</code>: ICE concluded, candidate pair selection 
 *              is now final</li>
 *              <li><code>FAILED</code>: Connectivity checks have been 
 *              completed, but media connection was not established</li>
 *            </ul>
 *            The transitions between states are covered in RFC5245.
 *            It could be said that it's network-only, as it only takes into 
 *            account the state of the network connection, ignoring other higher
 *          </li>
 *          <li>
 *            <code>IceCandidateFound</code>: Raised when a new candidate is 
 *            discovered. ICE candidates must be sent to the remote peer of the 
 *            connection. Failing to do so for some or all of the candidates 
 *            might render the connection unusable.
 *          </li>
 *          <li>
 *            <code>IceGatheringDone</code>: Raised when the ICE harvesting 
 *            process is completed. This means that all candidates have already 
 *            been discovered.
 *          </li>
 *          <li>
 *            <code>NewCandidatePairSelected</code>: Raised when a new ICE 
 *            candidate pair gets selected. The pair contains both local and 
 *            remote candidates being used for a component. This event can be 
 *            raised during a media session, if a new pair of candidates with 
 *            higher priority in the link are found.
 *          </li>
 *          <li>
 *            <code>DataChannelOpen</code>: Raised when a data channel is open.
 *          </li>
 *          <li>
 *            <code>DataChannelClose</code>: Raised when a data channel is 
 *            closed.
 *          </li>
 *        </ul>
 *        </p>
 *        <p>
 *        Registering to any of above events requires the application to provide
 *        </p>
 *        <p>
 *        Flow control and congestion management is one of the most important 
 *        features of WebRTC. WebRTC connections start with the lowest bandwidth
 *        </p>
 *        <p>
 *        The default bandwidth range of the endpoint is 100kbps-500kbps, but it
 *        <ul>
 *          <li>
 *            Input bandwidth control mechanism: Configuration interval used to 
 *            inform remote peer the range of bitrates that can be pushed into 
 *            this WebRtcEndpoint object.
 *            <ul style='list-style-type:circle'>
 *              <li>
 *                setMin/MaxVideoRecvBandwidth: sets Min/Max bitrate limits 
 *                expected for received video stream.
 *              </li>
 *              <li>
 *                setMin/MaxAudioRecvBandwidth: sets Min/Max bitrate limits 
 *                expected for received audio stream.
 *              </li>
 *            </ul>
 *            Max values are announced in the SDP, while min values are set to 
 *            limit the lower value of REMB packages. It follows that min values
 *          </li>
 *          <li>
 *            Output bandwidth control mechanism: Configuration interval used to
 *            <ul style='list-style-type:circle'>
 *              <li>
 *                setMin/MaxVideoSendBandwidth: sets Min/Max bitrate limits  for
 *              </li>
 *            </ul>
 *          </li>
 *        </ul>
 *        All bandwidth control parameters must be changed before the SDP 
 *        negotiation takes place, and can't be changed afterwards.
 *        </p>
 *        <p>
 *        DataChannels allow other media elements that make use of the DataPad, 
 *        to send arbitrary data. For instance, if there is a filter that 
 *        publishes event information, it'll be sent to the remote peer through 
 *        the channel. There is no API available for programmers to make use of 
 *        this feature in the WebRtcElement. DataChannels can be configured to 
 *        provide the following:
 *        <ul>
 *          <li>
 *            Reliable or partially reliable delivery of sent messages
 *          </li>
 *          <li>
 *            In-order or out-of-order delivery of sent messages
 *          </li>
 *        </ul>
 *        Unreliable, out-of-order delivery is equivalent to raw UDP semantics. 
 *        The message may make it, or it may not, and order is not important. 
 *        However, the channel can be configured to be <i>partially reliable</i>
 *        </p>
 *        <p>
 *        The possibility to create DataChannels in a WebRtcEndpoint must be 
 *        explicitly enabled when creating the endpoint, as this feature is 
 *        disabled by default. If this is the case, they can be created invoking
 *        <ul>
 *          <li>
 *           <code>label</code>: assigns a label to the DataChannel. This can 
 *           help identify each possible channel separately.
 *          </li>
 *          <li>
 *            <code>ordered</code>: specifies if the DataChannel guarantees 
 *            order, which is the default mode. If maxPacketLifetime and 
 *            maxRetransmits have not been set, this enables reliable mode.
 *          </li>
 *          <li>
 *            <code>maxPacketLifeTime</code>: The time window in milliseconds, 
 *            during which transmissions and retransmissions may take place in 
 *            unreliable mode. This forces unreliable mode, even if 
 *            <code>ordered</code> has been activated.
 *          </li>
 *          <li>
 *            <code>maxRetransmits</code>: maximum number of retransmissions 
 *            that are attempted in unreliable mode. This forces unreliable 
 *            mode, even if <code>ordered</code> has been activated.
 *          </li>
 *          <li>
 *            <code>Protocol</code>: Name of the subprotocol used for data 
 *            communication.
 *          </li>
 *        </ul>
 *
 * @extends module:core/abstracts.BaseRtpEndpoint
 *
 * @constructor module:elements.WebRtcEndpoint
 *
 * @fires {@link module:elements#event:DataChannelClose DataChannelClose}
 * @fires {@link module:elements#event:DataChannelOpen DataChannelOpen}
 * @fires {@link module:elements#event:IceCandidateFound IceCandidateFound}
 * @fires {@link module:elements#event:IceComponentStateChange IceComponentStateChange}
 * @fires {@link module:elements#event:IceGatheringDone IceGatheringDone}
 * @fires {@link module:elements#event:NewCandidatePairSelected NewCandidatePairSelected}
 * @fires {@link module:elements#event:OnDataChannelClosed OnDataChannelClosed}
 * @fires {@link module:elements#event:OnDataChannelOpened OnDataChannelOpened}
 * @fires {@link module:elements#event:OnIceCandidate OnIceCandidate}
 * @fires {@link module:elements#event:OnIceComponentStateChanged OnIceComponentStateChanged}
 * @fires {@link module:elements#event:OnIceGatheringDone OnIceGatheringDone}
 */
function WebRtcEndpoint(){
  WebRtcEndpoint.super_.call(this);
};
inherits(WebRtcEndpoint, BaseRtpEndpoint);


//
// Public properties
//

/**
 * the ICE candidate pair (local and remote candidates) used by the ice library 
 * for each stream.
 *
 * @alias module:elements.WebRtcEndpoint#getICECandidatePairs
 *
 * @param {module:elements.WebRtcEndpoint~getICECandidatePairsCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getICECandidatePairs = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getICECandidatePairs', callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~getICECandidatePairsCallback
 * @param {external:Error} error
 * @param {module:elements/complexTypes.IceCandidatePair} result
 */

/**
 * the ICE connection state for all the connections.
 *
 * @alias module:elements.WebRtcEndpoint#getIceConnectionState
 *
 * @param {module:elements.WebRtcEndpoint~getIceConnectionStateCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getIceConnectionState = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getIceConnectionState', callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~getIceConnectionStateCallback
 * @param {external:Error} error
 * @param {module:elements/complexTypes.IceConnection} result
 */

/**
 * address of the STUN server (Only IP address are supported)
 *
 * @alias module:elements.WebRtcEndpoint#getStunServerAddress
 *
 * @param {module:elements.WebRtcEndpoint~getStunServerAddressCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getStunServerAddress = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getStunServerAddress', callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~getStunServerAddressCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * address of the STUN server (Only IP address are supported)
 *
 * @alias module:elements.WebRtcEndpoint#setStunServerAddress
 *
 * @param {external:String} stunServerAddress
 * @param {module:elements.WebRtcEndpoint~setStunServerAddressCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.setStunServerAddress = function(stunServerAddress, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'stunServerAddress', stunServerAddress, {required: true});

  var params = {
    stunServerAddress: stunServerAddress
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setStunServerAddress', params, callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~setStunServerAddressCallback
 * @param {external:Error} error
 */

/**
 * port of the STUN server
 *
 * @alias module:elements.WebRtcEndpoint#getStunServerPort
 *
 * @param {module:elements.WebRtcEndpoint~getStunServerPortCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getStunServerPort = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getStunServerPort', callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~getStunServerPortCallback
 * @param {external:Error} error
 * @param {external:Integer} result
 */

/**
 * port of the STUN server
 *
 * @alias module:elements.WebRtcEndpoint#setStunServerPort
 *
 * @param {external:Integer} stunServerPort
 * @param {module:elements.WebRtcEndpoint~setStunServerPortCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.setStunServerPort = function(stunServerPort, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int', 'stunServerPort', stunServerPort, {required: true});

  var params = {
    stunServerPort: stunServerPort
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setStunServerPort', params, callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~setStunServerPortCallback
 * @param {external:Error} error
 */

/**
 * TURN server URL with this format: 
 * <code>user:password@address:port(?transport=[udp|tcp|tls])</code>.</br><code>address</code>
 *
 * @alias module:elements.WebRtcEndpoint#getTurnUrl
 *
 * @param {module:elements.WebRtcEndpoint~getTurnUrlCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.getTurnUrl = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getTurnUrl', callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~getTurnUrlCallback
 * @param {external:Error} error
 * @param {external:String} result
 */

/**
 * TURN server URL with this format: 
 * <code>user:password@address:port(?transport=[udp|tcp|tls])</code>.</br><code>address</code>
 *
 * @alias module:elements.WebRtcEndpoint#setTurnUrl
 *
 * @param {external:String} turnUrl
 * @param {module:elements.WebRtcEndpoint~setTurnUrlCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.setTurnUrl = function(turnUrl, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'turnUrl', turnUrl, {required: true});

  var params = {
    turnUrl: turnUrl
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setTurnUrl', params, callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~setTurnUrlCallback
 * @param {external:Error} error
 */


//
// Public methods
//

/**
 * Process an ICE candidate sent by the remote peer of the connection.
 *
 * @alias module:elements.WebRtcEndpoint.addIceCandidate
 *
 * @param {module:elements/complexTypes.IceCandidate} candidate
 *  Remote ICE candidate
 *
 * @param {module:elements.WebRtcEndpoint~addIceCandidateCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.addIceCandidate = function(candidate, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('IceCandidate', 'candidate', candidate, {required: true});

  var params = {
    candidate: candidate
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'addIceCandidate', params, callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~addIceCandidateCallback
 * @param {external:Error} error
 */

/**
 * Closes an open data channel
 *
 * @alias module:elements.WebRtcEndpoint.closeDataChannel
 *
 * @param {external:Integer} channelId
 *  The channel identifier
 *
 * @param {module:elements.WebRtcEndpoint~closeDataChannelCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.closeDataChannel = function(channelId, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('int', 'channelId', channelId, {required: true});

  var params = {
    channelId: channelId
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'closeDataChannel', params, callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~closeDataChannelCallback
 * @param {external:Error} error
 */

/**
 * Create a new data channel, if data channels are supported. If they are not 
 * supported, this method throws an exception.
 *           Being supported means that the WebRtcEndpoint has been created with
 *           Otherwise, the method throws an exception, indicating that the 
 *           operation is not possible.</br>
 *           Data channels can work in either unreliable mode (analogous to User
 *           The two modes have a simple distinction:
 *           <ul>
 *             <li>Reliable mode guarantees the transmission of messages and 
 *             also the order in which they are delivered. This takes extra 
 *             overhead, thus potentially making this mode slower.</li>
 *             <li>Unreliable mode does not guarantee every message will get to 
 *             the other side nor what order they get there. This removes the 
 *             overhead, allowing this mode to work much faster.</li>
 *           </ul>
 *
 * @alias module:elements.WebRtcEndpoint.createDataChannel
 *
 * @param {external:String} [label]
 *  Channel's label
 *
 * @param {external:Boolean} [ordered]
 *  If the data channel should guarantee order or not. If true, and 
 *  maxPacketLifeTime and maxRetransmits have not been provided, reliable mode 
 *  is activated.
 *
 * @param {external:Integer} [maxPacketLifeTime]
 *  The time window (in milliseconds) during which transmissions and 
 *  retransmissions may take place in unreliable mode.</br>
 *                <hr/><b>Note</b> This forces unreliable mode, even if 
 *                <code>ordered</code> has been activated
 *
 * @param {external:Integer} [maxRetransmits]
 *  maximum number of retransmissions that are attempted in unreliable 
 *  mode.</br>
 *                <hr/><b>Note</b> This forces unreliable mode, even if 
 *                <code>ordered</code> has been activated
 *
 * @param {external:String} [protocol]
 *  Name of the subprotocol used for data communication
 *
 * @param {module:elements.WebRtcEndpoint~createDataChannelCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.createDataChannel = function(label, ordered, maxPacketLifeTime, maxRetransmits, protocol, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  callback = arguments[arguments.length-1] instanceof Function
           ? Array.prototype.pop.call(arguments)
           : undefined;

  switch(arguments.length){
    case 0: label = undefined;
    case 1: ordered = undefined;
    case 2: maxPacketLifeTime = undefined;
    case 3: maxRetransmits = undefined;
    case 4: protocol = undefined;
    break;
    case 5: 
    break;

    default:
      var error = new RangeError('Number of params ('+arguments.length+') not in range [0-5]');
          error.length = arguments.length;
          error.min = 0;
          error.max = 5;

      throw error;
  }

  checkType('String', 'label', label);
  checkType('boolean', 'ordered', ordered);
  checkType('int', 'maxPacketLifeTime', maxPacketLifeTime);
  checkType('int', 'maxRetransmits', maxRetransmits);
  checkType('String', 'protocol', protocol);

  var params = {
    label: label,
    ordered: ordered,
    maxPacketLifeTime: maxPacketLifeTime,
    maxRetransmits: maxRetransmits,
    protocol: protocol
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'createDataChannel', params, callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~createDataChannelCallback
 * @param {external:Error} error
 */

/**
 * Start the gathering of ICE candidates.</br>It must be called after 
 * SdpEndpoint::generateOffer or SdpEndpoint::processOffer for Trickle ICE. If 
 * invoked before generating or processing an SDP offer, the candidates gathered
 *
 * @alias module:elements.WebRtcEndpoint.gatherCandidates
 *
 * @param {module:elements.WebRtcEndpoint~gatherCandidatesCallback} [callback]
 *
 * @return {external:Promise}
 */
WebRtcEndpoint.prototype.gatherCandidates = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'gatherCandidates', callback), this)
};
/**
 * @callback module:elements.WebRtcEndpoint~gatherCandidatesCallback
 * @param {external:Error} error
 */


/**
 * @alias module:elements.WebRtcEndpoint.constructorParams
 *
 * @property {module:elements/complexTypes.CertificateKeyType} [certificateKeyType]
 *  Define the type of the certificate used in dtls
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the endpoint 
 *  belongs
 *
 * @property {external:Boolean} [useDataChannels]
 *  Activate data channels support
 */
WebRtcEndpoint.constructorParams = {
  certificateKeyType: {
    type: 'kurento.CertificateKeyType'  },
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  },
  useDataChannels: {
    type: 'boolean'  }
};

/**
 * @alias module:elements.WebRtcEndpoint.events
 *
 * @extends module:core/abstracts.BaseRtpEndpoint.events
 */
WebRtcEndpoint.events = BaseRtpEndpoint.events.concat(['DataChannelClose', 'DataChannelOpen', 'IceCandidateFound', 'IceComponentStateChange', 'IceGatheringDone', 'NewCandidatePairSelected', 'OnDataChannelClosed', 'OnDataChannelOpened', 'OnIceCandidate', 'OnIceComponentStateChanged', 'OnIceGatheringDone']);


/**
 * Checker for {@link module:elements.WebRtcEndpoint}
 *
 * @memberof module:elements
 *
 * @param {external:String} key
 * @param {module:elements.WebRtcEndpoint} value
 */
function checkWebRtcEndpoint(key, value)
{
  if(!(value instanceof WebRtcEndpoint))
    throw ChecktypeError(key, WebRtcEndpoint, value);
};


module.exports = WebRtcEndpoint;

WebRtcEndpoint.check = checkWebRtcEndpoint;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],94:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var SessionEndpoint = require('kurento-client-core').abstracts.SessionEndpoint;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * @classdesc
 *  Endpoint that enables Kurento to work as an HTTP server, allowing peer HTTP 
 *  clients to access media.
 *
 * @abstract
 * @extends module:core/abstracts.SessionEndpoint
 *
 * @constructor module:elements/abstracts.HttpEndpoint
 */
function HttpEndpoint(){
  HttpEndpoint.super_.call(this);
};
inherits(HttpEndpoint, SessionEndpoint);


//
// Public methods
//

/**
 * Obtains the URL associated to this endpoint
 *
 * @alias module:elements/abstracts.HttpEndpoint.getUrl
 *
 * @param {module:elements/abstracts.HttpEndpoint~getUrlCallback} [callback]
 *
 * @return {external:Promise}
 */
HttpEndpoint.prototype.getUrl = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getUrl', callback), this)
};
/**
 * @callback module:elements/abstracts.HttpEndpoint~getUrlCallback
 * @param {external:Error} error
 * @param {external:String} result
 *  The url as a String
 */


/**
 * @alias module:elements/abstracts.HttpEndpoint.constructorParams
 */
HttpEndpoint.constructorParams = {
};

/**
 * @alias module:elements/abstracts.HttpEndpoint.events
 *
 * @extends module:core/abstracts.SessionEndpoint.events
 */
HttpEndpoint.events = SessionEndpoint.events;


/**
 * Checker for {@link module:elements/abstracts.HttpEndpoint}
 *
 * @memberof module:elements/abstracts
 *
 * @param {external:String} key
 * @param {module:elements/abstracts.HttpEndpoint} value
 */
function checkHttpEndpoint(key, value)
{
  if(!(value instanceof HttpEndpoint))
    throw ChecktypeError(key, HttpEndpoint, value);
};


module.exports = HttpEndpoint;

HttpEndpoint.check = checkHttpEndpoint;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],95:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module elements/abstracts
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

var HttpEndpoint = require('./HttpEndpoint');


exports.HttpEndpoint = HttpEndpoint;

},{"./HttpEndpoint":94}],96:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * .
 *
 * @typedef elements/complexTypes.CertificateKeyType
 *
 * @type {(RSA|ECDSA)}
 */

/**
 * Checker for {@link module:elements/complexTypes.CertificateKeyType}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.CertificateKeyType} value
 */
function checkCertificateKeyType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('RSA|ECDSA'))
    throw SyntaxError(key+' param is not one of [RSA|ECDSA] ('+value+')');
};


module.exports = checkCertificateKeyType;

},{"kurento-client":"kurento-client"}],97:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Describes the encryption and authentication algorithms
 *
 * @typedef elements/complexTypes.CryptoSuite
 *
 * @type {(AES_128_CM_HMAC_SHA1_32|AES_128_CM_HMAC_SHA1_80|AES_256_CM_HMAC_SHA1_32|AES_256_CM_HMAC_SHA1_80)}
 */

/**
 * Checker for {@link module:elements/complexTypes.CryptoSuite}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.CryptoSuite} value
 */
function checkCryptoSuite(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('AES_128_CM_HMAC_SHA1_32|AES_128_CM_HMAC_SHA1_80|AES_256_CM_HMAC_SHA1_32|AES_256_CM_HMAC_SHA1_80'))
    throw SyntaxError(key+' param is not one of [AES_128_CM_HMAC_SHA1_32|AES_128_CM_HMAC_SHA1_80|AES_256_CM_HMAC_SHA1_32|AES_256_CM_HMAC_SHA1_80] ('+value+')');
};


module.exports = checkCryptoSuite;

},{"kurento-client":"kurento-client"}],98:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('kurento-client-core').complexTypes.ComplexType;


/**
 * IceCandidate representation based on standard 
 * (http://www.w3.org/TR/webrtc/#rtcicecandidate-type).
 *
 * @constructor module:elements/complexTypes.IceCandidate
 *
 * @property {external:String} candidate
 *  The candidate-attribute as defined in section 15.1 of ICE (rfc5245).
 * @property {external:String} sdpMid
 *  If present, this contains the identifier of the 'media stream 
 *  identification'.
 * @property {external:Integer} sdpMLineIndex
 *  The index (starting at zero) of the m-line in the SDP this candidate is 
 *  associated with.
 */
function IceCandidate(iceCandidateDict){
  if(!(this instanceof IceCandidate))
    return new IceCandidate(iceCandidateDict)

  iceCandidateDict = iceCandidateDict || {}

  // Check iceCandidateDict has the required fields
  checkType('String', 'iceCandidateDict.candidate', iceCandidateDict.candidate, {required: true});
  checkType('String', 'iceCandidateDict.sdpMid', iceCandidateDict.sdpMid, {required: true});
  checkType('int', 'iceCandidateDict.sdpMLineIndex', iceCandidateDict.sdpMLineIndex, {required: true});

  // Init parent class
  IceCandidate.super_.call(this, iceCandidateDict)

  // Set object properties
  Object.defineProperties(this, {
    candidate: {
      writable: true,
      enumerable: true,
      value: iceCandidateDict.candidate
    },
    sdpMid: {
      writable: true,
      enumerable: true,
      value: iceCandidateDict.sdpMid
    },
    sdpMLineIndex: {
      writable: true,
      enumerable: true,
      value: iceCandidateDict.sdpMLineIndex
    }
  })
}
inherits(IceCandidate, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(IceCandidate.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "IceCandidate"
  }
})

/**
 * Checker for {@link module:elements/complexTypes.IceCandidate}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.IceCandidate} value
 */
function checkIceCandidate(key, value)
{
  if(!(value instanceof IceCandidate))
    throw ChecktypeError(key, IceCandidate, value);
};


module.exports = IceCandidate;

IceCandidate.check = checkIceCandidate;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],99:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('kurento-client-core').complexTypes.ComplexType;


/**
 * The ICE candidate pair used by the ice library, for a certain stream.
 *
 * @constructor module:elements/complexTypes.IceCandidatePair
 *
 * @property {external:String} streamID
 *  Stream ID of the ice connection
 * @property {external:Integer} componentID
 *  Component ID of the ice connection
 * @property {external:String} localCandidate
 *  The local candidate used by the ice library.
 * @property {external:String} remoteCandidate
 *  The remote candidate used by the ice library.
 */
function IceCandidatePair(iceCandidatePairDict){
  if(!(this instanceof IceCandidatePair))
    return new IceCandidatePair(iceCandidatePairDict)

  iceCandidatePairDict = iceCandidatePairDict || {}

  // Check iceCandidatePairDict has the required fields
  checkType('String', 'iceCandidatePairDict.streamID', iceCandidatePairDict.streamID, {required: true});
  checkType('int', 'iceCandidatePairDict.componentID', iceCandidatePairDict.componentID, {required: true});
  checkType('String', 'iceCandidatePairDict.localCandidate', iceCandidatePairDict.localCandidate, {required: true});
  checkType('String', 'iceCandidatePairDict.remoteCandidate', iceCandidatePairDict.remoteCandidate, {required: true});

  // Init parent class
  IceCandidatePair.super_.call(this, iceCandidatePairDict)

  // Set object properties
  Object.defineProperties(this, {
    streamID: {
      writable: true,
      enumerable: true,
      value: iceCandidatePairDict.streamID
    },
    componentID: {
      writable: true,
      enumerable: true,
      value: iceCandidatePairDict.componentID
    },
    localCandidate: {
      writable: true,
      enumerable: true,
      value: iceCandidatePairDict.localCandidate
    },
    remoteCandidate: {
      writable: true,
      enumerable: true,
      value: iceCandidatePairDict.remoteCandidate
    }
  })
}
inherits(IceCandidatePair, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(IceCandidatePair.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "IceCandidatePair"
  }
})

/**
 * Checker for {@link module:elements/complexTypes.IceCandidatePair}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.IceCandidatePair} value
 */
function checkIceCandidatePair(key, value)
{
  if(!(value instanceof IceCandidatePair))
    throw ChecktypeError(key, IceCandidatePair, value);
};


module.exports = IceCandidatePair;

IceCandidatePair.check = checkIceCandidatePair;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],100:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * States of an ICE component.
 *
 * @typedef elements/complexTypes.IceComponentState
 *
 * @type {(DISCONNECTED|GATHERING|CONNECTING|CONNECTED|READY|FAILED)}
 */

/**
 * Checker for {@link module:elements/complexTypes.IceComponentState}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.IceComponentState} value
 */
function checkIceComponentState(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('DISCONNECTED|GATHERING|CONNECTING|CONNECTED|READY|FAILED'))
    throw SyntaxError(key+' param is not one of [DISCONNECTED|GATHERING|CONNECTING|CONNECTED|READY|FAILED] ('+value+')');
};


module.exports = checkIceComponentState;

},{"kurento-client":"kurento-client"}],101:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('kurento-client-core').complexTypes.ComplexType;


/**
 * The ICE connection state for a certain stream and component.
 *
 * @constructor module:elements/complexTypes.IceConnection
 *
 * @property {external:String} streamId
 *  The ID of the stream
 * @property {external:Integer} componentId
 *  The ID of the component
 * @property {module:elements/complexTypes.IceComponentState} state
 *  The state of the component
 */
function IceConnection(iceConnectionDict){
  if(!(this instanceof IceConnection))
    return new IceConnection(iceConnectionDict)

  iceConnectionDict = iceConnectionDict || {}

  // Check iceConnectionDict has the required fields
  checkType('String', 'iceConnectionDict.streamId', iceConnectionDict.streamId, {required: true});
  checkType('int', 'iceConnectionDict.componentId', iceConnectionDict.componentId, {required: true});
  checkType('IceComponentState', 'iceConnectionDict.state', iceConnectionDict.state, {required: true});

  // Init parent class
  IceConnection.super_.call(this, iceConnectionDict)

  // Set object properties
  Object.defineProperties(this, {
    streamId: {
      writable: true,
      enumerable: true,
      value: iceConnectionDict.streamId
    },
    componentId: {
      writable: true,
      enumerable: true,
      value: iceConnectionDict.componentId
    },
    state: {
      writable: true,
      enumerable: true,
      value: iceConnectionDict.state
    }
  })
}
inherits(IceConnection, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(IceConnection.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "IceConnection"
  }
})

/**
 * Checker for {@link module:elements/complexTypes.IceConnection}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.IceConnection} value
 */
function checkIceConnection(key, value)
{
  if(!(value instanceof IceConnection))
    throw ChecktypeError(key, IceConnection, value);
};


module.exports = IceConnection;

IceConnection.check = checkIceConnection;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],102:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var kurentoClient = require('kurento-client');



/**
 * Media Profile.
 * Currently WEBM, MP4 and JPEG are supported.
 *
 * @typedef elements/complexTypes.MediaProfileSpecType
 *
 * @type {(WEBM|MP4|WEBM_VIDEO_ONLY|WEBM_AUDIO_ONLY|MP4_VIDEO_ONLY|MP4_AUDIO_ONLY|JPEG_VIDEO_ONLY|KURENTO_SPLIT_RECORDER)}
 */

/**
 * Checker for {@link module:elements/complexTypes.MediaProfileSpecType}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.MediaProfileSpecType} value
 */
function checkMediaProfileSpecType(key, value)
{
  if(typeof value != 'string')
    throw SyntaxError(key+' param should be a String, not '+typeof value);

  if(!value.match('WEBM|MP4|WEBM_VIDEO_ONLY|WEBM_AUDIO_ONLY|MP4_VIDEO_ONLY|MP4_AUDIO_ONLY|JPEG_VIDEO_ONLY|KURENTO_SPLIT_RECORDER'))
    throw SyntaxError(key+' param is not one of [WEBM|MP4|WEBM_VIDEO_ONLY|WEBM_AUDIO_ONLY|MP4_VIDEO_ONLY|MP4_AUDIO_ONLY|JPEG_VIDEO_ONLY|KURENTO_SPLIT_RECORDER] ('+value+')');
};


module.exports = checkMediaProfileSpecType;

},{"kurento-client":"kurento-client"}],103:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('kurento-client-core').complexTypes.ComplexType;


/**
 * Security Descriptions for Media Streams
 *
 * @constructor module:elements/complexTypes.SDES
 *
 * @property {external:String} key
 *   A string representing the cryptographic key used. The length varies 
 *   depending on the cryptographic method used (30 bytes length for AES_128_CM,
 * @property {module:elements/complexTypes.CryptoSuite} crypto
 *  Selects the cryptographic suite to be used. For available values, please see
 */
function SDES(sDESDict){
  if(!(this instanceof SDES))
    return new SDES(sDESDict)

  sDESDict = sDESDict || {}

  // Check sDESDict has the required fields
  checkType('String', 'sDESDict.key', sDESDict.key);
  checkType('CryptoSuite', 'sDESDict.crypto', sDESDict.crypto);

  // Init parent class
  SDES.super_.call(this, sDESDict)

  // Set object properties
  Object.defineProperties(this, {
    key: {
      writable: true,
      enumerable: true,
      value: sDESDict.key
    },
    crypto: {
      writable: true,
      enumerable: true,
      value: sDESDict.crypto
    }
  })
}
inherits(SDES, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(SDES.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "SDES"
  }
})

/**
 * Checker for {@link module:elements/complexTypes.SDES}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.SDES} value
 */
function checkSDES(key, value)
{
  if(!(value instanceof SDES))
    throw ChecktypeError(key, SDES, value);
};


module.exports = SDES;

SDES.check = checkSDES;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],104:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var checkType = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;

var ComplexType = require('kurento-client-core').complexTypes.ComplexType;


/**
 *
 * @constructor module:elements/complexTypes.VideoInfo
 *
 * @property {external:Boolean} isSeekable
 *  Seek is possible in video source
 * @property {external:int64} seekableInit
 *  First video position to do seek in ms
 * @property {external:int64} seekableEnd
 *  Last video position to do seek in ms
 * @property {external:int64} duration
 *  Video duration in ms
 */
function VideoInfo(videoInfoDict){
  if(!(this instanceof VideoInfo))
    return new VideoInfo(videoInfoDict)

  videoInfoDict = videoInfoDict || {}

  // Check videoInfoDict has the required fields
  checkType('boolean', 'videoInfoDict.isSeekable', videoInfoDict.isSeekable, {required: true});
  checkType('int64', 'videoInfoDict.seekableInit', videoInfoDict.seekableInit, {required: true});
  checkType('int64', 'videoInfoDict.seekableEnd', videoInfoDict.seekableEnd, {required: true});
  checkType('int64', 'videoInfoDict.duration', videoInfoDict.duration, {required: true});

  // Init parent class
  VideoInfo.super_.call(this, videoInfoDict)

  // Set object properties
  Object.defineProperties(this, {
    isSeekable: {
      writable: true,
      enumerable: true,
      value: videoInfoDict.isSeekable
    },
    seekableInit: {
      writable: true,
      enumerable: true,
      value: videoInfoDict.seekableInit
    },
    seekableEnd: {
      writable: true,
      enumerable: true,
      value: videoInfoDict.seekableEnd
    },
    duration: {
      writable: true,
      enumerable: true,
      value: videoInfoDict.duration
    }
  })
}
inherits(VideoInfo, ComplexType)

// Private identifiers to allow re-construction of the complexType on the server
// They need to be enumerable so JSON.stringify() can access to them
Object.defineProperties(VideoInfo.prototype, {
  __module__: {
    enumerable: true,
    value: "kurento"
  },
  __type__: {
    enumerable: true,
    value: "VideoInfo"
  }
})

/**
 * Checker for {@link module:elements/complexTypes.VideoInfo}
 *
 * @memberof module:elements/complexTypes
 *
 * @param {external:String} key
 * @param {module:elements/complexTypes.VideoInfo} value
 */
function checkVideoInfo(key, value)
{
  if(!(value instanceof VideoInfo))
    throw ChecktypeError(key, VideoInfo, value);
};


module.exports = VideoInfo;

VideoInfo.check = checkVideoInfo;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],105:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module elements/complexTypes
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

var CertificateKeyType = require('./CertificateKeyType');
var CryptoSuite = require('./CryptoSuite');
var IceCandidate = require('./IceCandidate');
var IceCandidatePair = require('./IceCandidatePair');
var IceComponentState = require('./IceComponentState');
var IceConnection = require('./IceConnection');
var MediaProfileSpecType = require('./MediaProfileSpecType');
var SDES = require('./SDES');
var VideoInfo = require('./VideoInfo');


exports.CertificateKeyType = CertificateKeyType;
exports.CryptoSuite = CryptoSuite;
exports.IceCandidate = IceCandidate;
exports.IceCandidatePair = IceCandidatePair;
exports.IceComponentState = IceComponentState;
exports.IceConnection = IceConnection;
exports.MediaProfileSpecType = MediaProfileSpecType;
exports.SDES = SDES;
exports.VideoInfo = VideoInfo;

},{"./CertificateKeyType":96,"./CryptoSuite":97,"./IceCandidate":98,"./IceCandidatePair":99,"./IceComponentState":100,"./IceConnection":101,"./MediaProfileSpecType":102,"./SDES":103,"./VideoInfo":104}],106:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Filter = require('kurento-client-core').abstracts.Filter;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * FaceOverlayFilter interface. This type of {@link module:core/abstracts.Filter
 *
 * @classdesc
 *  FaceOverlayFilter interface. This type of {@link 
 *  module:core/abstracts.Filter Filter} detects faces in a video feed. The face
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.FaceOverlayFilter
 */
function FaceOverlayFilter(){
  FaceOverlayFilter.super_.call(this);
};
inherits(FaceOverlayFilter, Filter);


//
// Public methods
//

/**
 * Sets the image to use as overlay on the detected faces.
 *
 * @alias module:filters.FaceOverlayFilter.setOverlayedImage
 *
 * @param {external:String} uri
 *  URI where the image is located
 *
 * @param {external:Number} offsetXPercent
 *  the offset applied to the image, from the X coordinate of the detected face 
 *  upper right corner. A positive value indicates right displacement, while a 
 *  negative value moves the overlaid image to the left. This offset is 
 *  specified as a percentage of the face width.
 *  For example, to cover the detected face with the overlaid image, the 
 *  parameter has to be <code>0.0</code>. Values of <code>1.0</code> or 
 *  <code>-1.0</code> indicate that the image upper right corner will be at the 
 *  face´s X coord, +- the face´s width.
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {external:Number} offsetYPercent
 *  the offset applied to the image, from the Y coordinate of the detected face 
 *  upper right corner. A positive value indicates up displacement, while a 
 *  negative value moves the overlaid image down. This offset is specified as a 
 *  percentage of the face width.
 *  For example, to cover the detected face with the overlaid image, the 
 *  parameter has to be <code>0.0</code>. Values of <code>1.0</code> or 
 *  <code>-1.0</code> indicate that the image upper right corner will be at the 
 *  face´s Y coord, +- the face´s width.
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {external:Number} widthPercent
 *  proportional width of the overlaid image, relative to the width of the 
 *  detected face. A value of 1.0 implies that the overlaid image will have the 
 *  same width as the detected face. Values greater than 1.0 are allowed, while 
 *  negative values are forbidden.
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {external:Number} heightPercent
 *  proportional height of the overlaid image, relative to the height of the 
 *  detected face. A value of 1.0 implies that the overlaid image will have the 
 *  same height as the detected face. Values greater than 1.0 are allowed, while
 *  <hr/><b>Note</b>
 *      The parameter name is misleading, the value is not a percent but a ratio
 *
 * @param {module:filters.FaceOverlayFilter~setOverlayedImageCallback} [callback]
 *
 * @return {external:Promise}
 */
FaceOverlayFilter.prototype.setOverlayedImage = function(uri, offsetXPercent, offsetYPercent, widthPercent, heightPercent, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'uri', uri, {required: true});
  checkType('float', 'offsetXPercent', offsetXPercent, {required: true});
  checkType('float', 'offsetYPercent', offsetYPercent, {required: true});
  checkType('float', 'widthPercent', widthPercent, {required: true});
  checkType('float', 'heightPercent', heightPercent, {required: true});

  var params = {
    uri: uri,
    offsetXPercent: offsetXPercent,
    offsetYPercent: offsetYPercent,
    widthPercent: widthPercent,
    heightPercent: heightPercent
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'setOverlayedImage', params, callback), this)
};
/**
 * @callback module:filters.FaceOverlayFilter~setOverlayedImageCallback
 * @param {external:Error} error
 */

/**
 * Clear the image to be shown over each detected face. Stops overlaying the 
 * faces.
 *
 * @alias module:filters.FaceOverlayFilter.unsetOverlayedImage
 *
 * @param {module:filters.FaceOverlayFilter~unsetOverlayedImageCallback} [callback]
 *
 * @return {external:Promise}
 */
FaceOverlayFilter.prototype.unsetOverlayedImage = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'unsetOverlayedImage', callback), this)
};
/**
 * @callback module:filters.FaceOverlayFilter~unsetOverlayedImageCallback
 * @param {external:Error} error
 */


/**
 * @alias module:filters.FaceOverlayFilter.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  pipeline to which this {@link module:core/abstracts.Filter Filter} belons
 */
FaceOverlayFilter.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:filters.FaceOverlayFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
FaceOverlayFilter.events = Filter.events;


/**
 * Checker for {@link module:filters.FaceOverlayFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.FaceOverlayFilter} value
 */
function checkFaceOverlayFilter(key, value)
{
  if(!(value instanceof FaceOverlayFilter))
    throw ChecktypeError(key, FaceOverlayFilter, value);
};


module.exports = FaceOverlayFilter;

FaceOverlayFilter.check = checkFaceOverlayFilter;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],107:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Transaction = kurentoClient.TransactionsManager.Transaction;

var Filter = require('kurento-client-core').abstracts.Filter;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * Create a {@link module:filters.GStreamerFilter GStreamerFilter}
 *
 * @classdesc
 *  This is a generic filter interface, that creates GStreamer filters in the 
 *  media server.
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.GStreamerFilter
 */
function GStreamerFilter(){
  GStreamerFilter.super_.call(this);
};
inherits(GStreamerFilter, Filter);


//
// Public properties
//

/**
 * GStreamer command.
 *
 * @alias module:filters.GStreamerFilter#getCommand
 *
 * @param {module:filters.GStreamerFilter~getCommandCallback} [callback]
 *
 * @return {external:Promise}
 */
GStreamerFilter.prototype.getCommand = function(callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  var usePromise = false;
  
  if (callback == undefined) {
    usePromise = true;
  }
  
  if(!arguments.length) callback = undefined;

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'getCommand', callback), this)
};
/**
 * @callback module:filters.GStreamerFilter~getCommandCallback
 * @param {external:Error} error
 * @param {external:String} result
 */


/**
 * @alias module:filters.GStreamerFilter.constructorParams
 *
 * @property {external:String} command
 *  command that would be used to instantiate the filter, as in `gst-launch 
 *  <http://rpm.pbone.net/index.php3/stat/45/idpl/19531544/numer/1/nazwa/gst-launch-1.0>`__
 *
 * @property {external:FilterType} [filterType]
 *  Filter type that define if the filter is set as audio, video or autodetect
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the filter 
 *  belongs
 */
GStreamerFilter.constructorParams = {
  command: {
    type: 'String',
    required: true
  },
  filterType: {
    type: 'kurento.FilterType'  },
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:filters.GStreamerFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
GStreamerFilter.events = Filter.events;


/**
 * Checker for {@link module:filters.GStreamerFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.GStreamerFilter} value
 */
function checkGStreamerFilter(key, value)
{
  if(!(value instanceof GStreamerFilter))
    throw ChecktypeError(key, GStreamerFilter, value);
};


module.exports = GStreamerFilter;

GStreamerFilter.check = checkGStreamerFilter;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],108:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var checkType      = kurentoClient.checkType;
var ChecktypeError = checkType.ChecktypeError;


var Transaction = kurentoClient.TransactionsManager.Transaction;

var Filter = require('kurento-client-core').abstracts.Filter;


function noop(error, result) {
  if (error) console.trace(error);

  return result
};


/**
 * ImageOverlayFilter interface. This type of {@link 
 * module:core/abstracts.Filter Filter} draws an image in a configured position 
 * over a video feed.
 *
 * @classdesc
 *  ImageOverlayFilter interface. This type of {@link 
 *  module:core/abstracts.Filter Filter} draws an image in a configured position
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.ImageOverlayFilter
 */
function ImageOverlayFilter(){
  ImageOverlayFilter.super_.call(this);
};
inherits(ImageOverlayFilter, Filter);


//
// Public methods
//

/**
 * Add an image to be used as overlay.
 *
 * @alias module:filters.ImageOverlayFilter.addImage
 *
 * @param {external:String} id
 *  image ID
 *
 * @param {external:String} uri
 *  URI where the image is located
 *
 * @param {external:Number} offsetXPercent
 *  Percentage relative to the image width to calculate the X coordinate of the 
 *  position (left upper corner) [0..1]
 *
 * @param {external:Number} offsetYPercent
 *  Percentage relative to the image height to calculate the Y coordinate of the
 *
 * @param {external:Number} widthPercent
 *  Proportional width of the overlaid image, relative to the width of the video
 *
 * @param {external:Number} heightPercent
 *  Proportional height of the overlaid image, relative to the height of the 
 *  video [0..1].
 *
 * @param {external:Boolean} keepAspectRatio
 *  Keep the aspect ratio of the original image.
 *
 * @param {external:Boolean} center
 *  If the image doesn't fit in the dimensions, the image will be center into 
 *  the region defined by height and width.
 *
 * @param {module:filters.ImageOverlayFilter~addImageCallback} [callback]
 *
 * @return {external:Promise}
 */
ImageOverlayFilter.prototype.addImage = function(id, uri, offsetXPercent, offsetYPercent, widthPercent, heightPercent, keepAspectRatio, center, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'id', id, {required: true});
  checkType('String', 'uri', uri, {required: true});
  checkType('float', 'offsetXPercent', offsetXPercent, {required: true});
  checkType('float', 'offsetYPercent', offsetYPercent, {required: true});
  checkType('float', 'widthPercent', widthPercent, {required: true});
  checkType('float', 'heightPercent', heightPercent, {required: true});
  checkType('boolean', 'keepAspectRatio', keepAspectRatio, {required: true});
  checkType('boolean', 'center', center, {required: true});

  var params = {
    id: id,
    uri: uri,
    offsetXPercent: offsetXPercent,
    offsetYPercent: offsetYPercent,
    widthPercent: widthPercent,
    heightPercent: heightPercent,
    keepAspectRatio: keepAspectRatio,
    center: center
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'addImage', params, callback), this)
};
/**
 * @callback module:filters.ImageOverlayFilter~addImageCallback
 * @param {external:Error} error
 */

/**
 * Remove the image with the given ID.
 *
 * @alias module:filters.ImageOverlayFilter.removeImage
 *
 * @param {external:String} id
 *  Image ID to be removed
 *
 * @param {module:filters.ImageOverlayFilter~removeImageCallback} [callback]
 *
 * @return {external:Promise}
 */
ImageOverlayFilter.prototype.removeImage = function(id, callback){
  var transaction = (arguments[0] instanceof Transaction)
                  ? Array.prototype.shift.apply(arguments)
                  : undefined;

  checkType('String', 'id', id, {required: true});

  var params = {
    id: id
  };

  callback = (callback || noop).bind(this)

  return disguise(this._invoke(transaction, 'removeImage', params, callback), this)
};
/**
 * @callback module:filters.ImageOverlayFilter~removeImageCallback
 * @param {external:Error} error
 */


/**
 * @alias module:filters.ImageOverlayFilter.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  pipeline to which this {@link module:core/abstracts.Filter Filter} belons
 */
ImageOverlayFilter.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:filters.ImageOverlayFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
ImageOverlayFilter.events = Filter.events;


/**
 * Checker for {@link module:filters.ImageOverlayFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.ImageOverlayFilter} value
 */
function checkImageOverlayFilter(key, value)
{
  if(!(value instanceof ImageOverlayFilter))
    throw ChecktypeError(key, ImageOverlayFilter, value);
};


module.exports = ImageOverlayFilter;

ImageOverlayFilter.check = checkImageOverlayFilter;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],109:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Filter = require('kurento-client-core').abstracts.Filter;


/**
 * Builder for the {@link module:filters.ZBarFilter ZBarFilter}.
 *
 * @classdesc
 *  This filter detects <a 
 *  href="http://www.kurento.org/docs/current/glossary.html#term-qr">QR</a> 
 *  codes in a video feed. When a code is found, the filter raises a 
 *  :rom:evnt:`CodeFound` event.
 *
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters.ZBarFilter
 *
 * @fires {@link module:filters#event:CodeFound CodeFound}
 */
function ZBarFilter(){
  ZBarFilter.super_.call(this);
};
inherits(ZBarFilter, Filter);


/**
 * @alias module:filters.ZBarFilter.constructorParams
 *
 * @property {module:core.MediaPipeline} mediaPipeline
 *  the {@link module:core.MediaPipeline MediaPipeline} to which the filter 
 *  belongs
 */
ZBarFilter.constructorParams = {
  mediaPipeline: {
    type: 'kurento.MediaPipeline',
    required: true
  }
};

/**
 * @alias module:filters.ZBarFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
ZBarFilter.events = Filter.events.concat(['CodeFound']);


/**
 * Checker for {@link module:filters.ZBarFilter}
 *
 * @memberof module:filters
 *
 * @param {external:String} key
 * @param {module:filters.ZBarFilter} value
 */
function checkZBarFilter(key, value)
{
  if(!(value instanceof ZBarFilter))
    throw ChecktypeError(key, ZBarFilter, value);
};


module.exports = ZBarFilter;

ZBarFilter.check = checkZBarFilter;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],110:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var inherits = require('inherits');

var kurentoClient = require('kurento-client');

var disguise = kurentoClient.disguise;

var ChecktypeError = kurentoClient.checkType.ChecktypeError;

var Filter = require('kurento-client-core').abstracts.Filter;


/**
 * @classdesc
 *  Generic OpenCV Filter
 *
 * @abstract
 * @extends module:core/abstracts.Filter
 *
 * @constructor module:filters/abstracts.OpenCVFilter
 */
function OpenCVFilter(){
  OpenCVFilter.super_.call(this);
};
inherits(OpenCVFilter, Filter);


/**
 * @alias module:filters/abstracts.OpenCVFilter.constructorParams
 */
OpenCVFilter.constructorParams = {
};

/**
 * @alias module:filters/abstracts.OpenCVFilter.events
 *
 * @extends module:core/abstracts.Filter.events
 */
OpenCVFilter.events = Filter.events;


/**
 * Checker for {@link module:filters/abstracts.OpenCVFilter}
 *
 * @memberof module:filters/abstracts
 *
 * @param {external:String} key
 * @param {module:filters/abstracts.OpenCVFilter} value
 */
function checkOpenCVFilter(key, value)
{
  if(!(value instanceof OpenCVFilter))
    throw ChecktypeError(key, OpenCVFilter, value);
};


module.exports = OpenCVFilter;

OpenCVFilter.check = checkOpenCVFilter;

},{"inherits":"inherits","kurento-client":"kurento-client","kurento-client-core":"kurento-client-core"}],111:[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module filters/abstracts
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

var OpenCVFilter = require('./OpenCVFilter');


exports.OpenCVFilter = OpenCVFilter;

},{"./OpenCVFilter":110}],112:[function(require,module,exports){
function Mapper()
{
  var sources = {};


  this.forEach = function(callback)
  {
    for(var key in sources)
    {
      var source = sources[key];

      for(var key2 in source)
        callback(source[key2]);
    };
  };

  this.get = function(id, source)
  {
    var ids = sources[source];
    if(ids == undefined)
      return undefined;

    return ids[id];
  };

  this.remove = function(id, source)
  {
    var ids = sources[source];
    if(ids == undefined)
      return;

    delete ids[id];

    // Check it's empty
    for(var i in ids){return false}

    delete sources[source];
  };

  this.set = function(value, id, source)
  {
    if(value == undefined)
      return this.remove(id, source);

    var ids = sources[source];
    if(ids == undefined)
      sources[source] = ids = {};

    ids[id] = value;
  };
};


Mapper.prototype.pop = function(id, source)
{
  var value = this.get(id, source);
  if(value == undefined)
    return undefined;

  this.remove(id, source);

  return value;
};


module.exports = Mapper;

},{}],113:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var JsonRpcClient  = require('./jsonrpcclient');


exports.JsonRpcClient  = JsonRpcClient;
},{"./jsonrpcclient":114}],114:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var RpcBuilder = require('../..');
var WebSocketWithReconnection = require('./transports/webSocketWithReconnection');

Date.now = Date.now || function() {
    return +new Date;
};

var PING_INTERVAL = 5000;

var RECONNECTING = 'RECONNECTING';
var CONNECTED = 'CONNECTED';
var DISCONNECTED = 'DISCONNECTED';

var Logger = console;

/**
 *
 * heartbeat: interval in ms for each heartbeat message,
 * sendCloseMessage : true / false, before closing the connection, it sends a closeSession message
 * <pre>
 * ws : {
 * 	uri : URI to conntect to,
 *  useSockJS : true (use SockJS) / false (use WebSocket) by default,
 * 	onconnected : callback method to invoke when connection is successful,
 * 	ondisconnect : callback method to invoke when the connection is lost,
 * 	onreconnecting : callback method to invoke when the client is reconnecting,
 * 	onreconnected : callback method to invoke when the client succesfully reconnects,
 * 	onerror : callback method to invoke when there is an error
 * },
 * rpc : {
 * 	requestTimeout : timeout for a request,
 * 	sessionStatusChanged: callback method for changes in session status,
 * 	mediaRenegotiation: mediaRenegotiation
 * }
 * </pre>
 */
function JsonRpcClient(configuration) {

    var self = this;

    var wsConfig = configuration.ws;

    var notReconnectIfNumLessThan = -1;

    var pingNextNum = 0;
    var enabledPings = true;
    var pingPongStarted = false;
    var pingInterval;

    var status = DISCONNECTED;

    var onreconnecting = wsConfig.onreconnecting;
    var onreconnected = wsConfig.onreconnected;
    var onconnected = wsConfig.onconnected;
    var onerror = wsConfig.onerror;

    configuration.rpc.pull = function(params, request) {
        request.reply(null, "push");
    }

    wsConfig.onreconnecting = function() {
        Logger.debug("--------- ONRECONNECTING -----------");
        if (status === RECONNECTING) {
            Logger.error("Websocket already in RECONNECTING state when receiving a new ONRECONNECTING message. Ignoring it");
            return;
        }

        status = RECONNECTING;
        if (onreconnecting) {
            onreconnecting();
        }
    }

    wsConfig.onreconnected = function() {
        Logger.debug("--------- ONRECONNECTED -----------");
        if (status === CONNECTED) {
            Logger.error("Websocket already in CONNECTED state when receiving a new ONRECONNECTED message. Ignoring it");
            return;
        }
        status = CONNECTED;

        enabledPings = true;
        updateNotReconnectIfLessThan();
        usePing();

        if (onreconnected) {
            onreconnected();
        }
    }

    wsConfig.onconnected = function() {
        Logger.debug("--------- ONCONNECTED -----------");
        if (status === CONNECTED) {
            Logger.error("Websocket already in CONNECTED state when receiving a new ONCONNECTED message. Ignoring it");
            return;
        }
        status = CONNECTED;

        enabledPings = true;
        usePing();

        if (onconnected) {
            onconnected();
        }
    }

    wsConfig.onerror = function(error) {
        Logger.debug("--------- ONERROR -----------");

        status = DISCONNECTED;

        if (onerror) {
            onerror(error);
        }
    }

    var ws = new WebSocketWithReconnection(wsConfig);

    Logger.debug('Connecting websocket to URI: ' + wsConfig.uri);

    var rpcBuilderOptions = {
        request_timeout: configuration.rpc.requestTimeout,
        ping_request_timeout: configuration.rpc.heartbeatRequestTimeout
    };

    var rpc = new RpcBuilder(RpcBuilder.packers.JsonRPC, rpcBuilderOptions, ws,
        function(request) {

            Logger.debug('Received request: ' + JSON.stringify(request));

            try {
                var func = configuration.rpc[request.method];

                if (func === undefined) {
                    Logger.error("Method " + request.method + " not registered in client");
                } else {
                    func(request.params, request);
                }
            } catch (err) {
                Logger.error('Exception processing request: ' + JSON.stringify(request));
                Logger.error(err);
            }
        });

    this.send = function(method, params, callback) {
        if (method !== 'ping') {
            Logger.debug('Request: method:' + method + " params:" + JSON.stringify(params));
        }

        var requestTime = Date.now();

        rpc.encode(method, params, function(error, result) {
            if (error) {
                try {
                    Logger.error("ERROR:" + error.message + " in Request: method:" +
                        method + " params:" + JSON.stringify(params) + " request:" +
                        error.request);
                    if (error.data) {
                        Logger.error("ERROR DATA:" + JSON.stringify(error.data));
                    }
                } catch (e) {}
                error.requestTime = requestTime;
            }
            if (callback) {
                if (result != undefined && result.value !== 'pong') {
                    Logger.debug('Response: ' + JSON.stringify(result));
                }
                callback(error, result);
            }
        });
    }

    function updateNotReconnectIfLessThan() {
        Logger.debug("notReconnectIfNumLessThan = " + pingNextNum + ' (old=' +
            notReconnectIfNumLessThan + ')');
        notReconnectIfNumLessThan = pingNextNum;
    }

    function sendPing() {
        if (enabledPings) {
            var params = null;
            if (pingNextNum == 0 || pingNextNum == notReconnectIfNumLessThan) {
                params = {
                    interval: configuration.heartbeat || PING_INTERVAL
                };
            }
            pingNextNum++;

            self.send('ping', params, (function(pingNum) {
                return function(error, result) {
                    if (error) {
                        Logger.debug("Error in ping request #" + pingNum + " (" +
                            error.message + ")");
                        if (pingNum > notReconnectIfNumLessThan) {
                            enabledPings = false;
                            updateNotReconnectIfLessThan();
                            Logger.debug("Server did not respond to ping message #" +
                                pingNum + ". Reconnecting... ");
                            ws.reconnectWs();
                        }
                    }
                }
            })(pingNextNum));
        } else {
            Logger.debug("Trying to send ping, but ping is not enabled");
        }
    }

    /*
    * If configuration.hearbeat has any value, the ping-pong will work with the interval
    * of configuration.hearbeat
    */
    function usePing() {
        if (!pingPongStarted) {
            Logger.debug("Starting ping (if configured)")
            pingPongStarted = true;

            if (configuration.heartbeat != undefined) {
                pingInterval = setInterval(sendPing, configuration.heartbeat);
                sendPing();
            }
        }
    }

    this.close = function() {
        Logger.debug("Closing jsonRpcClient explicitly by client");

        if (pingInterval != undefined) {
            Logger.debug("Clearing ping interval");
            clearInterval(pingInterval);
        }
        pingPongStarted = false;
        enabledPings = false;

        if (configuration.sendCloseMessage) {
            Logger.debug("Sending close message")
            this.send('closeSession', null, function(error, result) {
                if (error) {
                    Logger.error("Error sending close message: " + JSON.stringify(error));
                }
                ws.close();
            });
        } else {
			ws.close();
        }
    }

    // This method is only for testing
    this.forceClose = function(millis) {
        ws.forceClose(millis);
    }

    this.reconnect = function() {
        ws.reconnectWs();
    }
}


module.exports = JsonRpcClient;

},{"../..":117,"./transports/webSocketWithReconnection":116}],115:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var WebSocketWithReconnection  = require('./webSocketWithReconnection');


exports.WebSocketWithReconnection  = WebSocketWithReconnection;
},{"./webSocketWithReconnection":116}],116:[function(require,module,exports){
(function (global){
/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

var BrowserWebSocket = global.WebSocket || global.MozWebSocket;

var Logger = console;

/**
 * Get either the `WebSocket` or `MozWebSocket` globals
 * in the browser or try to resolve WebSocket-compatible
 * interface exposed by `ws` for Node-like environment.
 */

var WebSocket = BrowserWebSocket;
if (!WebSocket && typeof window === 'undefined') {
    try {
        WebSocket = require('ws');
    } catch (e) { }
}

//var SockJS = require('sockjs-client');

var MAX_RETRIES = 2000; // Forever...
var RETRY_TIME_MS = 3000; // FIXME: Implement exponential wait times...

var CONNECTING = 0;
var OPEN = 1;
var CLOSING = 2;
var CLOSED = 3;

/*
config = {
		uri : wsUri,
		useSockJS : true (use SockJS) / false (use WebSocket) by default,
		onconnected : callback method to invoke when connection is successful,
		ondisconnect : callback method to invoke when the connection is lost,
		onreconnecting : callback method to invoke when the client is reconnecting,
		onreconnected : callback method to invoke when the client succesfully reconnects,
	};
*/
function WebSocketWithReconnection(config) {

    var closing = false;
    var registerMessageHandler;
    var wsUri = config.uri;
    var useSockJS = config.useSockJS;
    var reconnecting = false;

    var forcingDisconnection = false;

    var ws;

    if (useSockJS) {
        ws = new SockJS(wsUri);
    } else {
        ws = new WebSocket(wsUri);
    }

    ws.onopen = function() {
        logConnected(ws, wsUri);
        if (config.onconnected) {
            config.onconnected();
        }
    };

    ws.onerror = function(error) {
        Logger.error("Could not connect to " + wsUri + " (invoking onerror if defined)", error);
        if (config.onerror) {
            config.onerror(error);
        }
    };

    function logConnected(ws, wsUri) {
        try {
            Logger.debug("WebSocket connected to " + wsUri);
        } catch (e) {
            Logger.error(e);
        }
    }

    var reconnectionOnClose = function() {
        if (ws.readyState === CLOSED) {
            if (closing) {
                Logger.debug("Connection closed by user");
            } else {
                Logger.debug("Connection closed unexpectecly. Reconnecting...");
                reconnectToSameUri(MAX_RETRIES, 1);
            }
        } else {
            Logger.debug("Close callback from previous websocket. Ignoring it");
        }
    };

    ws.onclose = reconnectionOnClose;

    function reconnectToSameUri(maxRetries, numRetries) {
        Logger.debug("reconnectToSameUri (attempt #" + numRetries + ", max=" + maxRetries + ")");

        if (numRetries === 1) {
            if (reconnecting) {
                Logger.warn("Trying to reconnectToNewUri when reconnecting... Ignoring this reconnection.")
                return;
            } else {
                reconnecting = true;
            }

            if (config.onreconnecting) {
                config.onreconnecting();
            }
        }

        if (forcingDisconnection) {
            reconnectToNewUri(maxRetries, numRetries, wsUri);

        } else {
            if (config.newWsUriOnReconnection) {
                config.newWsUriOnReconnection(function(error, newWsUri) {

                    if (error) {
                        Logger.debug(error);
                        setTimeout(function() {
                            reconnectToSameUri(maxRetries, numRetries + 1);
                        }, RETRY_TIME_MS);
                    } else {
                        reconnectToNewUri(maxRetries, numRetries, newWsUri);
                    }
                })
            } else {
                reconnectToNewUri(maxRetries, numRetries, wsUri);
            }
        }
    }

    // TODO Test retries. How to force not connection?
    function reconnectToNewUri(maxRetries, numRetries, reconnectWsUri) {
        Logger.debug("Reconnection attempt #" + numRetries);

        ws.close();

        wsUri = reconnectWsUri || wsUri;

        var newWs;
        if (useSockJS) {
            newWs = new SockJS(wsUri);
        } else {
            newWs = new WebSocket(wsUri);
        }

        newWs.onopen = function() {
            Logger.debug("Reconnected after " + numRetries + " attempts...");
            logConnected(newWs, wsUri);
            reconnecting = false;
            registerMessageHandler();
            if (config.onreconnected()) {
                config.onreconnected();
            }

            newWs.onclose = reconnectionOnClose;
        };

        var onErrorOrClose = function(error) {
            Logger.warn("Reconnection error: ", error);

            if (numRetries === maxRetries) {
                if (config.ondisconnect) {
                    config.ondisconnect();
                }
            } else {
                setTimeout(function() {
                    reconnectToSameUri(maxRetries, numRetries + 1);
                }, RETRY_TIME_MS);
            }
        };

        newWs.onerror = onErrorOrClose;

        ws = newWs;
    }

    this.close = function() {
        closing = true;
        ws.close();
    };


    // This method is only for testing
    this.forceClose = function(millis) {
        Logger.debug("Testing: Force WebSocket close");

        if (millis) {
            Logger.debug("Testing: Change wsUri for " + millis + " millis to simulate net failure");
            var goodWsUri = wsUri;
            wsUri = "wss://21.234.12.34.4:443/";

            forcingDisconnection = true;

            setTimeout(function() {
                Logger.debug("Testing: Recover good wsUri " + goodWsUri);
                wsUri = goodWsUri;

                forcingDisconnection = false;

            }, millis);
        }

        ws.close();
    };

    this.reconnectWs = function() {
        Logger.debug("reconnectWs");
        reconnectToSameUri(MAX_RETRIES, 1, wsUri);
    };

    this.send = function(message) {
        ws.send(message);
    };

    this.addEventListener = function(type, callback) {
        registerMessageHandler = function() {
            ws.addEventListener(type, callback);
        };

        registerMessageHandler();
    };
}

module.exports = WebSocketWithReconnection;

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"ws":154}],117:[function(require,module,exports){
/*
 * (C) Copyright 2014 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */


var defineProperty_IE8 = false
if(Object.defineProperty)
{
  try
  {
    Object.defineProperty({}, "x", {});
  }
  catch(e)
  {
    defineProperty_IE8 = true
  }
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/bind
if (!Function.prototype.bind) {
  Function.prototype.bind = function(oThis) {
    if (typeof this !== 'function') {
      // closest thing possible to the ECMAScript 5
      // internal IsCallable function
      throw new TypeError('Function.prototype.bind - what is trying to be bound is not callable');
    }

    var aArgs   = Array.prototype.slice.call(arguments, 1),
        fToBind = this,
        fNOP    = function() {},
        fBound  = function() {
          return fToBind.apply(this instanceof fNOP && oThis
                 ? this
                 : oThis,
                 aArgs.concat(Array.prototype.slice.call(arguments)));
        };

    fNOP.prototype = this.prototype;
    fBound.prototype = new fNOP();

    return fBound;
  };
}


var EventEmitter = require('events').EventEmitter;

var inherits = require('inherits');

var packers = require('./packers');
var Mapper = require('./Mapper');


var BASE_TIMEOUT = 5000;


function unifyResponseMethods(responseMethods)
{
  if(!responseMethods) return {};

  for(var key in responseMethods)
  {
    var value = responseMethods[key];

    if(typeof value == 'string')
      responseMethods[key] =
      {
        response: value
      }
  };

  return responseMethods;
};

function unifyTransport(transport)
{
  if(!transport) return;

  // Transport as a function
  if(transport instanceof Function)
    return {send: transport};

  // WebSocket & DataChannel
  if(transport.send instanceof Function)
    return transport;

  // Message API (Inter-window & WebWorker)
  if(transport.postMessage instanceof Function)
  {
    transport.send = transport.postMessage;
    return transport;
  }

  // Stream API
  if(transport.write instanceof Function)
  {
    transport.send = transport.write;
    return transport;
  }

  // Transports that only can receive messages, but not send
  if(transport.onmessage !== undefined) return;
  if(transport.pause instanceof Function) return;

  throw new SyntaxError("Transport is not a function nor a valid object");
};


/**
 * Representation of a RPC notification
 *
 * @class
 *
 * @constructor
 *
 * @param {String} method -method of the notification
 * @param params - parameters of the notification
 */
function RpcNotification(method, params)
{
  if(defineProperty_IE8)
  {
    this.method = method
    this.params = params
  }
  else
  {
    Object.defineProperty(this, 'method', {value: method, enumerable: true});
    Object.defineProperty(this, 'params', {value: params, enumerable: true});
  }
};


/**
 * @class
 *
 * @constructor
 *
 * @param {object} packer
 *
 * @param {object} [options]
 *
 * @param {object} [transport]
 *
 * @param {Function} [onRequest]
 */
function RpcBuilder(packer, options, transport, onRequest)
{
  var self = this;

  if(!packer)
    throw new SyntaxError('Packer is not defined');

  if(!packer.pack || !packer.unpack)
    throw new SyntaxError('Packer is invalid');

  var responseMethods = unifyResponseMethods(packer.responseMethods);


  if(options instanceof Function)
  {
    if(transport != undefined)
      throw new SyntaxError("There can't be parameters after onRequest");

    onRequest = options;
    transport = undefined;
    options   = undefined;
  };

  if(options && options.send instanceof Function)
  {
    if(transport && !(transport instanceof Function))
      throw new SyntaxError("Only a function can be after transport");

    onRequest = transport;
    transport = options;
    options   = undefined;
  };

  if(transport instanceof Function)
  {
    if(onRequest != undefined)
      throw new SyntaxError("There can't be parameters after onRequest");

    onRequest = transport;
    transport = undefined;
  };

  if(transport && transport.send instanceof Function)
    if(onRequest && !(onRequest instanceof Function))
      throw new SyntaxError("Only a function can be after transport");

  options = options || {};


  EventEmitter.call(this);

  if(onRequest)
    this.on('request', onRequest);


  if(defineProperty_IE8)
    this.peerID = options.peerID
  else
    Object.defineProperty(this, 'peerID', {value: options.peerID});

  var max_retries = options.max_retries || 0;


  function transportMessage(event)
  {
    self.decode(event.data || event);
  };

  this.getTransport = function()
  {
    return transport;
  }
  this.setTransport = function(value)
  {
    // Remove listener from old transport
    if(transport)
    {
      // W3C transports
      if(transport.removeEventListener)
        transport.removeEventListener('message', transportMessage);

      // Node.js Streams API
      else if(transport.removeListener)
        transport.removeListener('data', transportMessage);
    };

    // Set listener on new transport
    if(value)
    {
      // W3C transports
      if(value.addEventListener)
        value.addEventListener('message', transportMessage);

      // Node.js Streams API
      else if(value.addListener)
        value.addListener('data', transportMessage);
    };

    transport = unifyTransport(value);
  }

  if(!defineProperty_IE8)
    Object.defineProperty(this, 'transport',
    {
      get: this.getTransport.bind(this),
      set: this.setTransport.bind(this)
    })

  this.setTransport(transport);


  var request_timeout      = options.request_timeout      || BASE_TIMEOUT;
  var ping_request_timeout = options.ping_request_timeout || request_timeout;
  var response_timeout     = options.response_timeout     || BASE_TIMEOUT;
  var duplicates_timeout   = options.duplicates_timeout   || BASE_TIMEOUT;


  var requestID = 0;

  var requests  = new Mapper();
  var responses = new Mapper();
  var processedResponses = new Mapper();

  var message2Key = {};


  /**
   * Store the response to prevent to process duplicate request later
   */
  function storeResponse(message, id, dest)
  {
    var response =
    {
      message: message,
      /** Timeout to auto-clean old responses */
      timeout: setTimeout(function()
      {
        responses.remove(id, dest);
      },
      response_timeout)
    };

    responses.set(response, id, dest);
  };

  /**
   * Store the response to ignore duplicated messages later
   */
  function storeProcessedResponse(ack, from)
  {
    var timeout = setTimeout(function()
    {
      processedResponses.remove(ack, from);
    },
    duplicates_timeout);

    processedResponses.set(timeout, ack, from);
  };


  /**
   * Representation of a RPC request
   *
   * @class
   * @extends RpcNotification
   *
   * @constructor
   *
   * @param {String} method -method of the notification
   * @param params - parameters of the notification
   * @param {Integer} id - identifier of the request
   * @param [from] - source of the notification
   */
  function RpcRequest(method, params, id, from, transport)
  {
    RpcNotification.call(this, method, params);

    this.getTransport = function()
    {
      return transport;
    }
    this.setTransport = function(value)
    {
      transport = unifyTransport(value);
    }

    if(!defineProperty_IE8)
      Object.defineProperty(this, 'transport',
      {
        get: this.getTransport.bind(this),
        set: this.setTransport.bind(this)
      })

    var response = responses.get(id, from);

    /**
     * @constant {Boolean} duplicated
     */
    if(!(transport || self.getTransport()))
    {
      if(defineProperty_IE8)
        this.duplicated = Boolean(response)
      else
        Object.defineProperty(this, 'duplicated',
        {
          value: Boolean(response)
        });
    }

    var responseMethod = responseMethods[method];

    this.pack = packer.pack.bind(packer, this, id)

    /**
     * Generate a response to this request
     *
     * @param {Error} [error]
     * @param {*} [result]
     *
     * @returns {string}
     */
    this.reply = function(error, result, transport)
    {
      // Fix optional parameters
      if(error instanceof Function || error && error.send instanceof Function)
      {
        if(result != undefined)
          throw new SyntaxError("There can't be parameters after callback");

        transport = error;
        result = null;
        error = undefined;
      }

      else if(result instanceof Function
      || result && result.send instanceof Function)
      {
        if(transport != undefined)
          throw new SyntaxError("There can't be parameters after callback");

        transport = result;
        result = null;
      };

      transport = unifyTransport(transport);

      // Duplicated request, remove old response timeout
      if(response)
        clearTimeout(response.timeout);

      if(from != undefined)
      {
        if(error)
          error.dest = from;

        if(result)
          result.dest = from;
      };

      var message;

      // New request or overriden one, create new response with provided data
      if(error || result != undefined)
      {
        if(self.peerID != undefined)
        {
          if(error)
            error.from = self.peerID;
          else
            result.from = self.peerID;
        }

        // Protocol indicates that responses has own request methods
        if(responseMethod)
        {
          if(responseMethod.error == undefined && error)
            message =
            {
              error: error
            };

          else
          {
            var method = error
                       ? responseMethod.error
                       : responseMethod.response;

            message =
            {
              method: method,
              params: error || result
            };
          }
        }
        else
          message =
          {
            error:  error,
            result: result
          };

        message = packer.pack(message, id);
      }

      // Duplicate & not-overriden request, re-send old response
      else if(response)
        message = response.message;

      // New empty reply, response null value
      else
        message = packer.pack({result: null}, id);

      // Store the response to prevent to process a duplicated request later
      storeResponse(message, id, from);

      // Return the stored response so it can be directly send back
      transport = transport || this.getTransport() || self.getTransport();

      if(transport)
        return transport.send(message);

      return message;
    }
  };
  inherits(RpcRequest, RpcNotification);


  function cancel(message)
  {
    var key = message2Key[message];
    if(!key) return;

    delete message2Key[message];

    var request = requests.pop(key.id, key.dest);
    if(!request) return;

    clearTimeout(request.timeout);

    // Start duplicated responses timeout
    storeProcessedResponse(key.id, key.dest);
  };

  /**
   * Allow to cancel a request and don't wait for a response
   *
   * If `message` is not given, cancel all the request
   */
  this.cancel = function(message)
  {
    if(message) return cancel(message);

    for(var message in message2Key)
      cancel(message);
  };


  this.close = function()
  {
    // Prevent to receive new messages
    var transport = this.getTransport();
    if(transport && transport.close)
       transport.close();

    // Request & processed responses
    this.cancel();

    processedResponses.forEach(clearTimeout);

    // Responses
    responses.forEach(function(response)
    {
      clearTimeout(response.timeout);
    });
  };


  /**
   * Generates and encode a JsonRPC 2.0 message
   *
   * @param {String} method -method of the notification
   * @param params - parameters of the notification
   * @param [dest] - destination of the notification
   * @param {object} [transport] - transport where to send the message
   * @param [callback] - function called when a response to this request is
   *   received. If not defined, a notification will be send instead
   *
   * @returns {string} A raw JsonRPC 2.0 request or notification string
   */
  this.encode = function(method, params, dest, transport, callback)
  {
    // Fix optional parameters
    if(params instanceof Function)
    {
      if(dest != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = params;
      transport = undefined;
      dest      = undefined;
      params    = undefined;
    }

    else if(dest instanceof Function)
    {
      if(transport != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = dest;
      transport = undefined;
      dest      = undefined;
    }

    else if(transport instanceof Function)
    {
      if(callback != undefined)
        throw new SyntaxError("There can't be parameters after callback");

      callback  = transport;
      transport = undefined;
    };

    if(self.peerID != undefined)
    {
      params = params || {};

      params.from = self.peerID;
    };

    if(dest != undefined)
    {
      params = params || {};

      params.dest = dest;
    };

    // Encode message
    var message =
    {
      method: method,
      params: params
    };

    if(callback)
    {
      var id = requestID++;
      var retried = 0;

      message = packer.pack(message, id);

      function dispatchCallback(error, result)
      {
        self.cancel(message);

        callback(error, result);
      };

      var request =
      {
        message:         message,
        callback:        dispatchCallback,
        responseMethods: responseMethods[method] || {}
      };

      var encode_transport = unifyTransport(transport);

      function sendRequest(transport)
      {
        var rt = (method === 'ping' ? ping_request_timeout : request_timeout);
        request.timeout = setTimeout(timeout, rt*Math.pow(2, retried++));
        message2Key[message] = {id: id, dest: dest};
        requests.set(request, id, dest);

        transport = transport || encode_transport || self.getTransport();
        if(transport)
          return transport.send(message);

        return message;
      };

      function retry(transport)
      {
        transport = unifyTransport(transport);

        console.warn(retried+' retry for request message:',message);

        var timeout = processedResponses.pop(id, dest);
        clearTimeout(timeout);

        return sendRequest(transport);
      };

      function timeout()
      {
        if(retried < max_retries)
          return retry(transport);

        var error = new Error('Request has timed out');
            error.request = message;

        error.retry = retry;

        dispatchCallback(error)
      };

      return sendRequest(transport);
    };

    // Return the packed message
    message = packer.pack(message);

    transport = transport || this.getTransport();
    if(transport)
      return transport.send(message);

    return message;
  };

  /**
   * Decode and process a JsonRPC 2.0 message
   *
   * @param {string} message - string with the content of the message
   *
   * @returns {RpcNotification|RpcRequest|undefined} - the representation of the
   *   notification or the request. If a response was processed, it will return
   *   `undefined` to notify that it was processed
   *
   * @throws {TypeError} - Message is not defined
   */
  this.decode = function(message, transport)
  {
    if(!message)
      throw new TypeError("Message is not defined");

    try
    {
      message = packer.unpack(message);
    }
    catch(e)
    {
      // Ignore invalid messages
      return console.debug(e, message);
    };

    var id     = message.id;
    var ack    = message.ack;
    var method = message.method;
    var params = message.params || {};

    var from = params.from;
    var dest = params.dest;

    // Ignore messages send by us
    if(self.peerID != undefined && from == self.peerID) return;

    // Notification
    if(id == undefined && ack == undefined)
    {
      var notification = new RpcNotification(method, params);

      if(self.emit('request', notification)) return;
      return notification;
    };


    function processRequest()
    {
      // If we have a transport and it's a duplicated request, reply inmediatly
      transport = unifyTransport(transport) || self.getTransport();
      if(transport)
      {
        var response = responses.get(id, from);
        if(response)
          return transport.send(response.message);
      };

      var idAck = (id != undefined) ? id : ack;
      var request = new RpcRequest(method, params, idAck, from, transport);

      if(self.emit('request', request)) return;
      return request;
    };

    function processResponse(request, error, result)
    {
      request.callback(error, result);
    };

    function duplicatedResponse(timeout)
    {
      console.warn("Response already processed", message);

      // Update duplicated responses timeout
      clearTimeout(timeout);
      storeProcessedResponse(ack, from);
    };


    // Request, or response with own method
    if(method)
    {
      // Check if it's a response with own method
      if(dest == undefined || dest == self.peerID)
      {
        var request = requests.get(ack, from);
        if(request)
        {
          var responseMethods = request.responseMethods;

          if(method == responseMethods.error)
            return processResponse(request, params);

          if(method == responseMethods.response)
            return processResponse(request, null, params);

          return processRequest();
        }

        var processed = processedResponses.get(ack, from);
        if(processed)
          return duplicatedResponse(processed);
      }

      // Request
      return processRequest();
    };

    var error  = message.error;
    var result = message.result;

    // Ignore responses not send to us
    if(error  && error.dest  && error.dest  != self.peerID) return;
    if(result && result.dest && result.dest != self.peerID) return;

    // Response
    var request = requests.get(ack, from);
    if(!request)
    {
      var processed = processedResponses.get(ack, from);
      if(processed)
        return duplicatedResponse(processed);

      return console.warn("No callback was defined for this message", message);
    };

    // Process response
    processResponse(request, error, result);
  };
};
inherits(RpcBuilder, EventEmitter);


RpcBuilder.RpcNotification = RpcNotification;


module.exports = RpcBuilder;

var clients = require('./clients');
var transports = require('./clients/transports');

RpcBuilder.clients = clients;
RpcBuilder.clients.transports = transports;
RpcBuilder.packers = packers;

},{"./Mapper":112,"./clients":113,"./clients/transports":115,"./packers":120,"events":21,"inherits":"inherits"}],118:[function(require,module,exports){
/**
 * JsonRPC 2.0 packer
 */

/**
 * Pack a JsonRPC 2.0 message
 *
 * @param {Object} message - object to be packaged. It requires to have all the
 *   fields needed by the JsonRPC 2.0 message that it's going to be generated
 *
 * @return {String} - the stringified JsonRPC 2.0 message
 */
function pack(message, id)
{
  var result =
  {
    jsonrpc: "2.0"
  };

  // Request
  if(message.method)
  {
    result.method = message.method;

    if(message.params)
      result.params = message.params;

    // Request is a notification
    if(id != undefined)
      result.id = id;
  }

  // Response
  else if(id != undefined)
  {
    if(message.error)
    {
      if(message.result !== undefined)
        throw new TypeError("Both result and error are defined");

      result.error = message.error;
    }
    else if(message.result !== undefined)
      result.result = message.result;
    else
      throw new TypeError("No result or error is defined");

    result.id = id;
  };

  return JSON.stringify(result);
};

/**
 * Unpack a JsonRPC 2.0 message
 *
 * @param {String} message - string with the content of the JsonRPC 2.0 message
 *
 * @throws {TypeError} - Invalid JsonRPC version
 *
 * @return {Object} - object filled with the JsonRPC 2.0 message content
 */
function unpack(message)
{
  var result = message;

  if(typeof message === 'string' || message instanceof String) {
    result = JSON.parse(message);
  }

  // Check if it's a valid message

  var version = result.jsonrpc;
  if(version !== '2.0')
    throw new TypeError("Invalid JsonRPC version '" + version + "': " + message);

  // Response
  if(result.method == undefined)
  {
    if(result.id == undefined)
      throw new TypeError("Invalid message: "+message);

    var result_defined = result.result !== undefined;
    var error_defined  = result.error  !== undefined;

    // Check only result or error is defined, not both or none
    if(result_defined && error_defined)
      throw new TypeError("Both result and error are defined: "+message);

    if(!result_defined && !error_defined)
      throw new TypeError("No result or error is defined: "+message);

    result.ack = result.id;
    delete result.id;
  }

  // Return unpacked message
  return result;
};


exports.pack   = pack;
exports.unpack = unpack;

},{}],119:[function(require,module,exports){
function pack(message)
{
  throw new TypeError("Not yet implemented");
};

function unpack(message)
{
  throw new TypeError("Not yet implemented");
};


exports.pack   = pack;
exports.unpack = unpack;

},{}],120:[function(require,module,exports){
var JsonRPC = require('./JsonRPC');
var XmlRPC  = require('./XmlRPC');


exports.JsonRPC = JsonRPC;
exports.XmlRPC  = XmlRPC;

},{"./JsonRPC":118,"./XmlRPC":119}],121:[function(require,module,exports){
(function (process){
'use strict';

if (typeof process === 'undefined' ||
    !process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = { nextTick: nextTick };
} else {
  module.exports = process
}

function nextTick(fn, arg1, arg2, arg3) {
  if (typeof fn !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }
  var len = arguments.length;
  var args, i;
  switch (len) {
  case 0:
  case 1:
    return process.nextTick(fn);
  case 2:
    return process.nextTick(function afterTickOne() {
      fn.call(null, arg1);
    });
  case 3:
    return process.nextTick(function afterTickTwo() {
      fn.call(null, arg1, arg2);
    });
  case 4:
    return process.nextTick(function afterTickThree() {
      fn.call(null, arg1, arg2, arg3);
    });
  default:
    args = new Array(len - 1);
    i = 0;
    while (i < args.length) {
      args[i++] = arguments[i];
    }
    return process.nextTick(function afterTick() {
      fn.apply(null, args);
    });
  }
}


}).call(this,require('_process'))
},{"_process":122}],122:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],123:[function(require,module,exports){
(function (global){
/*! https://mths.be/punycode v1.4.1 by @mathias */
;(function(root) {

	/** Detect free variables */
	var freeExports = typeof exports == 'object' && exports &&
		!exports.nodeType && exports;
	var freeModule = typeof module == 'object' && module &&
		!module.nodeType && module;
	var freeGlobal = typeof global == 'object' && global;
	if (
		freeGlobal.global === freeGlobal ||
		freeGlobal.window === freeGlobal ||
		freeGlobal.self === freeGlobal
	) {
		root = freeGlobal;
	}

	/**
	 * The `punycode` object.
	 * @name punycode
	 * @type Object
	 */
	var punycode,

	/** Highest positive signed 32-bit float value */
	maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

	/** Bootstring parameters */
	base = 36,
	tMin = 1,
	tMax = 26,
	skew = 38,
	damp = 700,
	initialBias = 72,
	initialN = 128, // 0x80
	delimiter = '-', // '\x2D'

	/** Regular expressions */
	regexPunycode = /^xn--/,
	regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
	regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

	/** Error messages */
	errors = {
		'overflow': 'Overflow: input needs wider integers to process',
		'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
		'invalid-input': 'Invalid input'
	},

	/** Convenience shortcuts */
	baseMinusTMin = base - tMin,
	floor = Math.floor,
	stringFromCharCode = String.fromCharCode,

	/** Temporary variable */
	key;

	/*--------------------------------------------------------------------------*/

	/**
	 * A generic error utility function.
	 * @private
	 * @param {String} type The error type.
	 * @returns {Error} Throws a `RangeError` with the applicable error message.
	 */
	function error(type) {
		throw new RangeError(errors[type]);
	}

	/**
	 * A generic `Array#map` utility function.
	 * @private
	 * @param {Array} array The array to iterate over.
	 * @param {Function} callback The function that gets called for every array
	 * item.
	 * @returns {Array} A new array of values returned by the callback function.
	 */
	function map(array, fn) {
		var length = array.length;
		var result = [];
		while (length--) {
			result[length] = fn(array[length]);
		}
		return result;
	}

	/**
	 * A simple `Array#map`-like wrapper to work with domain name strings or email
	 * addresses.
	 * @private
	 * @param {String} domain The domain name or email address.
	 * @param {Function} callback The function that gets called for every
	 * character.
	 * @returns {Array} A new string of characters returned by the callback
	 * function.
	 */
	function mapDomain(string, fn) {
		var parts = string.split('@');
		var result = '';
		if (parts.length > 1) {
			// In email addresses, only the domain name should be punycoded. Leave
			// the local part (i.e. everything up to `@`) intact.
			result = parts[0] + '@';
			string = parts[1];
		}
		// Avoid `split(regex)` for IE8 compatibility. See #17.
		string = string.replace(regexSeparators, '\x2E');
		var labels = string.split('.');
		var encoded = map(labels, fn).join('.');
		return result + encoded;
	}

	/**
	 * Creates an array containing the numeric code points of each Unicode
	 * character in the string. While JavaScript uses UCS-2 internally,
	 * this function will convert a pair of surrogate halves (each of which
	 * UCS-2 exposes as separate characters) into a single code point,
	 * matching UTF-16.
	 * @see `punycode.ucs2.encode`
	 * @see <https://mathiasbynens.be/notes/javascript-encoding>
	 * @memberOf punycode.ucs2
	 * @name decode
	 * @param {String} string The Unicode input string (UCS-2).
	 * @returns {Array} The new array of code points.
	 */
	function ucs2decode(string) {
		var output = [],
		    counter = 0,
		    length = string.length,
		    value,
		    extra;
		while (counter < length) {
			value = string.charCodeAt(counter++);
			if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
				// high surrogate, and there is a next character
				extra = string.charCodeAt(counter++);
				if ((extra & 0xFC00) == 0xDC00) { // low surrogate
					output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
				} else {
					// unmatched surrogate; only append this code unit, in case the next
					// code unit is the high surrogate of a surrogate pair
					output.push(value);
					counter--;
				}
			} else {
				output.push(value);
			}
		}
		return output;
	}

	/**
	 * Creates a string based on an array of numeric code points.
	 * @see `punycode.ucs2.decode`
	 * @memberOf punycode.ucs2
	 * @name encode
	 * @param {Array} codePoints The array of numeric code points.
	 * @returns {String} The new Unicode string (UCS-2).
	 */
	function ucs2encode(array) {
		return map(array, function(value) {
			var output = '';
			if (value > 0xFFFF) {
				value -= 0x10000;
				output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
				value = 0xDC00 | value & 0x3FF;
			}
			output += stringFromCharCode(value);
			return output;
		}).join('');
	}

	/**
	 * Converts a basic code point into a digit/integer.
	 * @see `digitToBasic()`
	 * @private
	 * @param {Number} codePoint The basic numeric code point value.
	 * @returns {Number} The numeric value of a basic code point (for use in
	 * representing integers) in the range `0` to `base - 1`, or `base` if
	 * the code point does not represent a value.
	 */
	function basicToDigit(codePoint) {
		if (codePoint - 48 < 10) {
			return codePoint - 22;
		}
		if (codePoint - 65 < 26) {
			return codePoint - 65;
		}
		if (codePoint - 97 < 26) {
			return codePoint - 97;
		}
		return base;
	}

	/**
	 * Converts a digit/integer into a basic code point.
	 * @see `basicToDigit()`
	 * @private
	 * @param {Number} digit The numeric value of a basic code point.
	 * @returns {Number} The basic code point whose value (when used for
	 * representing integers) is `digit`, which needs to be in the range
	 * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
	 * used; else, the lowercase form is used. The behavior is undefined
	 * if `flag` is non-zero and `digit` has no uppercase form.
	 */
	function digitToBasic(digit, flag) {
		//  0..25 map to ASCII a..z or A..Z
		// 26..35 map to ASCII 0..9
		return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
	}

	/**
	 * Bias adaptation function as per section 3.4 of RFC 3492.
	 * https://tools.ietf.org/html/rfc3492#section-3.4
	 * @private
	 */
	function adapt(delta, numPoints, firstTime) {
		var k = 0;
		delta = firstTime ? floor(delta / damp) : delta >> 1;
		delta += floor(delta / numPoints);
		for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
			delta = floor(delta / baseMinusTMin);
		}
		return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
	}

	/**
	 * Converts a Punycode string of ASCII-only symbols to a string of Unicode
	 * symbols.
	 * @memberOf punycode
	 * @param {String} input The Punycode string of ASCII-only symbols.
	 * @returns {String} The resulting string of Unicode symbols.
	 */
	function decode(input) {
		// Don't use UCS-2
		var output = [],
		    inputLength = input.length,
		    out,
		    i = 0,
		    n = initialN,
		    bias = initialBias,
		    basic,
		    j,
		    index,
		    oldi,
		    w,
		    k,
		    digit,
		    t,
		    /** Cached calculation results */
		    baseMinusT;

		// Handle the basic code points: let `basic` be the number of input code
		// points before the last delimiter, or `0` if there is none, then copy
		// the first basic code points to the output.

		basic = input.lastIndexOf(delimiter);
		if (basic < 0) {
			basic = 0;
		}

		for (j = 0; j < basic; ++j) {
			// if it's not a basic code point
			if (input.charCodeAt(j) >= 0x80) {
				error('not-basic');
			}
			output.push(input.charCodeAt(j));
		}

		// Main decoding loop: start just after the last delimiter if any basic code
		// points were copied; start at the beginning otherwise.

		for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

			// `index` is the index of the next character to be consumed.
			// Decode a generalized variable-length integer into `delta`,
			// which gets added to `i`. The overflow checking is easier
			// if we increase `i` as we go, then subtract off its starting
			// value at the end to obtain `delta`.
			for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

				if (index >= inputLength) {
					error('invalid-input');
				}

				digit = basicToDigit(input.charCodeAt(index++));

				if (digit >= base || digit > floor((maxInt - i) / w)) {
					error('overflow');
				}

				i += digit * w;
				t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

				if (digit < t) {
					break;
				}

				baseMinusT = base - t;
				if (w > floor(maxInt / baseMinusT)) {
					error('overflow');
				}

				w *= baseMinusT;

			}

			out = output.length + 1;
			bias = adapt(i - oldi, out, oldi == 0);

			// `i` was supposed to wrap around from `out` to `0`,
			// incrementing `n` each time, so we'll fix that now:
			if (floor(i / out) > maxInt - n) {
				error('overflow');
			}

			n += floor(i / out);
			i %= out;

			// Insert `n` at position `i` of the output
			output.splice(i++, 0, n);

		}

		return ucs2encode(output);
	}

	/**
	 * Converts a string of Unicode symbols (e.g. a domain name label) to a
	 * Punycode string of ASCII-only symbols.
	 * @memberOf punycode
	 * @param {String} input The string of Unicode symbols.
	 * @returns {String} The resulting Punycode string of ASCII-only symbols.
	 */
	function encode(input) {
		var n,
		    delta,
		    handledCPCount,
		    basicLength,
		    bias,
		    j,
		    m,
		    q,
		    k,
		    t,
		    currentValue,
		    output = [],
		    /** `inputLength` will hold the number of code points in `input`. */
		    inputLength,
		    /** Cached calculation results */
		    handledCPCountPlusOne,
		    baseMinusT,
		    qMinusT;

		// Convert the input in UCS-2 to Unicode
		input = ucs2decode(input);

		// Cache the length
		inputLength = input.length;

		// Initialize the state
		n = initialN;
		delta = 0;
		bias = initialBias;

		// Handle the basic code points
		for (j = 0; j < inputLength; ++j) {
			currentValue = input[j];
			if (currentValue < 0x80) {
				output.push(stringFromCharCode(currentValue));
			}
		}

		handledCPCount = basicLength = output.length;

		// `handledCPCount` is the number of code points that have been handled;
		// `basicLength` is the number of basic code points.

		// Finish the basic string - if it is not empty - with a delimiter
		if (basicLength) {
			output.push(delimiter);
		}

		// Main encoding loop:
		while (handledCPCount < inputLength) {

			// All non-basic code points < n have been handled already. Find the next
			// larger one:
			for (m = maxInt, j = 0; j < inputLength; ++j) {
				currentValue = input[j];
				if (currentValue >= n && currentValue < m) {
					m = currentValue;
				}
			}

			// Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
			// but guard against overflow
			handledCPCountPlusOne = handledCPCount + 1;
			if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
				error('overflow');
			}

			delta += (m - n) * handledCPCountPlusOne;
			n = m;

			for (j = 0; j < inputLength; ++j) {
				currentValue = input[j];

				if (currentValue < n && ++delta > maxInt) {
					error('overflow');
				}

				if (currentValue == n) {
					// Represent delta as a generalized variable-length integer
					for (q = delta, k = base; /* no condition */; k += base) {
						t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
						if (q < t) {
							break;
						}
						qMinusT = q - t;
						baseMinusT = base - t;
						output.push(
							stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
						);
						q = floor(qMinusT / baseMinusT);
					}

					output.push(stringFromCharCode(digitToBasic(q, 0)));
					bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
					delta = 0;
					++handledCPCount;
				}
			}

			++delta;
			++n;

		}
		return output.join('');
	}

	/**
	 * Converts a Punycode string representing a domain name or an email address
	 * to Unicode. Only the Punycoded parts of the input will be converted, i.e.
	 * it doesn't matter if you call it on a string that has already been
	 * converted to Unicode.
	 * @memberOf punycode
	 * @param {String} input The Punycoded domain name or email address to
	 * convert to Unicode.
	 * @returns {String} The Unicode representation of the given Punycode
	 * string.
	 */
	function toUnicode(input) {
		return mapDomain(input, function(string) {
			return regexPunycode.test(string)
				? decode(string.slice(4).toLowerCase())
				: string;
		});
	}

	/**
	 * Converts a Unicode string representing a domain name or an email address to
	 * Punycode. Only the non-ASCII parts of the domain name will be converted,
	 * i.e. it doesn't matter if you call it with a domain that's already in
	 * ASCII.
	 * @memberOf punycode
	 * @param {String} input The domain name or email address to convert, as a
	 * Unicode string.
	 * @returns {String} The Punycode representation of the given domain name or
	 * email address.
	 */
	function toASCII(input) {
		return mapDomain(input, function(string) {
			return regexNonASCII.test(string)
				? 'xn--' + encode(string)
				: string;
		});
	}

	/*--------------------------------------------------------------------------*/

	/** Define the public API */
	punycode = {
		/**
		 * A string representing the current Punycode.js version number.
		 * @memberOf punycode
		 * @type String
		 */
		'version': '1.4.1',
		/**
		 * An object of methods to convert from JavaScript's internal character
		 * representation (UCS-2) to Unicode code points, and back.
		 * @see <https://mathiasbynens.be/notes/javascript-encoding>
		 * @memberOf punycode
		 * @type Object
		 */
		'ucs2': {
			'decode': ucs2decode,
			'encode': ucs2encode
		},
		'decode': decode,
		'encode': encode,
		'toASCII': toASCII,
		'toUnicode': toUnicode
	};

	/** Expose `punycode` */
	// Some AMD build optimizers, like r.js, check for specific condition patterns
	// like the following:
	if (
		typeof define == 'function' &&
		typeof define.amd == 'object' &&
		define.amd
	) {
		define('punycode', function() {
			return punycode;
		});
	} else if (freeExports && freeModule) {
		if (module.exports == freeExports) {
			// in Node.js, io.js, or RingoJS v0.8.0+
			freeModule.exports = punycode;
		} else {
			// in Narwhal or RingoJS v0.7.0-
			for (key in punycode) {
				punycode.hasOwnProperty(key) && (freeExports[key] = punycode[key]);
			}
		}
	} else {
		// in Rhino or a web browser
		root.punycode = punycode;
	}

}(this));

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],124:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

// If obj.hasOwnProperty has been overridden, then calling
// obj.hasOwnProperty(prop) will break.
// See: https://github.com/joyent/node/issues/1707
function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

module.exports = function(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  var obj = {};

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  var regexp = /\+/g;
  qs = qs.split(sep);

  var maxKeys = 1000;
  if (options && typeof options.maxKeys === 'number') {
    maxKeys = options.maxKeys;
  }

  var len = qs.length;
  // maxKeys <= 0 means that we should not limit keys count
  if (maxKeys > 0 && len > maxKeys) {
    len = maxKeys;
  }

  for (var i = 0; i < len; ++i) {
    var x = qs[i].replace(regexp, '%20'),
        idx = x.indexOf(eq),
        kstr, vstr, k, v;

    if (idx >= 0) {
      kstr = x.substr(0, idx);
      vstr = x.substr(idx + 1);
    } else {
      kstr = x;
      vstr = '';
    }

    k = decodeURIComponent(kstr);
    v = decodeURIComponent(vstr);

    if (!hasOwnProperty(obj, k)) {
      obj[k] = v;
    } else if (isArray(obj[k])) {
      obj[k].push(v);
    } else {
      obj[k] = [obj[k], v];
    }
  }

  return obj;
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

},{}],125:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var stringifyPrimitive = function(v) {
  switch (typeof v) {
    case 'string':
      return v;

    case 'boolean':
      return v ? 'true' : 'false';

    case 'number':
      return isFinite(v) ? v : '';

    default:
      return '';
  }
};

module.exports = function(obj, sep, eq, name) {
  sep = sep || '&';
  eq = eq || '=';
  if (obj === null) {
    obj = undefined;
  }

  if (typeof obj === 'object') {
    return map(objectKeys(obj), function(k) {
      var ks = encodeURIComponent(stringifyPrimitive(k)) + eq;
      if (isArray(obj[k])) {
        return map(obj[k], function(v) {
          return ks + encodeURIComponent(stringifyPrimitive(v));
        }).join(sep);
      } else {
        return ks + encodeURIComponent(stringifyPrimitive(obj[k]));
      }
    }).join(sep);

  }

  if (!name) return '';
  return encodeURIComponent(stringifyPrimitive(name)) + eq +
         encodeURIComponent(stringifyPrimitive(obj));
};

var isArray = Array.isArray || function (xs) {
  return Object.prototype.toString.call(xs) === '[object Array]';
};

function map (xs, f) {
  if (xs.map) return xs.map(f);
  var res = [];
  for (var i = 0; i < xs.length; i++) {
    res.push(f(xs[i], i));
  }
  return res;
}

var objectKeys = Object.keys || function (obj) {
  var res = [];
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) res.push(key);
  }
  return res;
};

},{}],126:[function(require,module,exports){
'use strict';

exports.decode = exports.parse = require('./decode');
exports.encode = exports.stringify = require('./encode');

},{"./decode":124,"./encode":125}],127:[function(require,module,exports){
module.exports = require('./lib/_stream_duplex.js');

},{"./lib/_stream_duplex.js":128}],128:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    keys.push(key);
  }return keys;
};
/*</replacement>*/

module.exports = Duplex;

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

{
  // avoid scope creep, the keys array can then be collected
  var keys = objectKeys(Writable.prototype);
  for (var v = 0; v < keys.length; v++) {
    var method = keys[v];
    if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
  }
}

function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false) this.readable = false;

  if (options && options.writable === false) this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false) this.allowHalfOpen = false;

  this.once('end', onend);
}

Object.defineProperty(Duplex.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._writableState.highWaterMark;
  }
});

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended) return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  pna.nextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

Object.defineProperty(Duplex.prototype, 'destroyed', {
  get: function () {
    if (this._readableState === undefined || this._writableState === undefined) {
      return false;
    }
    return this._readableState.destroyed && this._writableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (this._readableState === undefined || this._writableState === undefined) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
    this._writableState.destroyed = value;
  }
});

Duplex.prototype._destroy = function (err, cb) {
  this.push(null);
  this.end();

  pna.nextTick(cb, err);
};
},{"./_stream_readable":130,"./_stream_writable":132,"core-util-is":18,"inherits":"inherits","process-nextick-args":121}],129:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};
},{"./_stream_transform":131,"core-util-is":18,"inherits":"inherits"}],130:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

module.exports = Readable;

/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Readable.ReadableState = ReadableState;

/*<replacement>*/
var EE = require('events').EventEmitter;

var EElistenerCount = function (emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/
var Stream = require('./internal/streams/stream');
/*</replacement>*/

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
var OurUint8Array = global.Uint8Array || function () {};
function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}
function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

/*</replacement>*/

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

/*<replacement>*/
var debugUtil = require('util');
var debug = void 0;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var BufferList = require('./internal/streams/BufferList');
var destroyImpl = require('./internal/streams/destroy');
var StringDecoder;

util.inherits(Readable, Stream);

var kProxyEvents = ['error', 'close', 'destroy', 'pause', 'resume'];

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function') return emitter.prependListener(event, fn);

  // This is a hack to make sure that our error handler is attached before any
  // userland ones.  NEVER DO THIS. This is here only because this code needs
  // to continue to work with older versions of Node.js that do not include
  // the prependListener() method. The goal is to eventually remove this hack.
  if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
}

function ReadableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  var isDuplex = stream instanceof Duplex;

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (isDuplex) this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var readableHwm = options.readableHighWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;

  if (hwm || hwm === 0) this.highWaterMark = hwm;else if (isDuplex && (readableHwm || readableHwm === 0)) this.highWaterMark = readableHwm;else this.highWaterMark = defaultHwm;

  // cast to ints.
  this.highWaterMark = Math.floor(this.highWaterMark);

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;

  // has it been destroyed
  this.destroyed = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  if (!(this instanceof Readable)) return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options) {
    if (typeof options.read === 'function') this._read = options.read;

    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }

  Stream.call(this);
}

Object.defineProperty(Readable.prototype, 'destroyed', {
  get: function () {
    if (this._readableState === undefined) {
      return false;
    }
    return this._readableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._readableState) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
  }
});

Readable.prototype.destroy = destroyImpl.destroy;
Readable.prototype._undestroy = destroyImpl.undestroy;
Readable.prototype._destroy = function (err, cb) {
  this.push(null);
  cb(err);
};

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;
  var skipChunkCheck;

  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding = encoding || state.defaultEncoding;
      if (encoding !== state.encoding) {
        chunk = Buffer.from(chunk, encoding);
        encoding = '';
      }
      skipChunkCheck = true;
    }
  } else {
    skipChunkCheck = true;
  }

  return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function (chunk) {
  return readableAddChunk(this, chunk, null, true, false);
};

function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {
  var state = stream._readableState;
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else {
    var er;
    if (!skipChunkCheck) er = chunkInvalid(state, chunk);
    if (er) {
      stream.emit('error', er);
    } else if (state.objectMode || chunk && chunk.length > 0) {
      if (typeof chunk !== 'string' && !state.objectMode && Object.getPrototypeOf(chunk) !== Buffer.prototype) {
        chunk = _uint8ArrayToBuffer(chunk);
      }

      if (addToFront) {
        if (state.endEmitted) stream.emit('error', new Error('stream.unshift() after end event'));else addChunk(stream, state, chunk, true);
      } else if (state.ended) {
        stream.emit('error', new Error('stream.push() after EOF'));
      } else {
        state.reading = false;
        if (state.decoder && !encoding) {
          chunk = state.decoder.write(chunk);
          if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);else maybeReadMore(stream, state);
        } else {
          addChunk(stream, state, chunk, false);
        }
      }
    } else if (!addToFront) {
      state.reading = false;
    }
  }

  return needMoreData(state);
}

function addChunk(stream, state, chunk, addToFront) {
  if (state.flowing && state.length === 0 && !state.sync) {
    stream.emit('data', chunk);
    stream.read(0);
  } else {
    // update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);

    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

function chunkInvalid(state, chunk) {
  var er;
  if (!_isUint8Array(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}

// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
}

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

// backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;
  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  }
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n;
  // Don't have enough
  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }
  return state.length;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;

  if (n !== 0) state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  } else {
    state.length -= n;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);

  return ret;
};

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync) pna.nextTick(emitReadable_, stream);else emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}

// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    pna.nextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;else len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  this.emit('error', new Error('_read() is not implemented'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;

  var endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) pna.nextTick(endFn);else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable, unpipeInfo) {
    debug('onunpipe');
    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  // If the user pushes more data while we're writing to dest then we'll end up
  // in ondata again. However, we only want to increase awaitDrain once because
  // dest will only emit one 'drain' event for the multiple writes.
  // => Introduce a guard on increasing awaitDrain.
  var increasedAwaitDrain = false;
  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    increasedAwaitDrain = false;
    var ret = dest.write(chunk);
    if (false === ret && !increasedAwaitDrain) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
        increasedAwaitDrain = true;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) dest.emit('error', er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function () {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;
  var unpipeInfo = { hasUnpiped: false };

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0) return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;

    if (!dest) dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this, unpipeInfo);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++) {
      dests[i].emit('unpipe', this, unpipeInfo);
    }return this;
  }

  // try to find the right one.
  var index = indexOf(state.pipes, dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];

  dest.emit('unpipe', this, unpipeInfo);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  if (ev === 'data') {
    // Start flowing on next tick if stream isn't explicitly paused
    if (this._readableState.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    var state = this._readableState;
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.emittedReadable = false;
      if (!state.reading) {
        pna.nextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    pna.nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  state.awaitDrain = 0;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null) {}
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  var _this = this;

  var state = this._readableState;
  var paused = false;

  stream.on('end', function () {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) _this.push(chunk);
    }

    _this.push(null);
  });

  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = _this.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function (method) {
        return function () {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // proxy certain important events.
  for (var n = 0; n < kProxyEvents.length; n++) {
    stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
  }

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  this._read = function (n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return this;
};

Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._readableState.highWaterMark;
  }
});

// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;

  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.head.data;else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = fromListPartial(n, state.buffer, state.decoder);
  }

  return ret;
}

// Extracts only enough buffered data to satisfy the amount requested.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromListPartial(n, list, hasStrings) {
  var ret;
  if (n < list.head.data.length) {
    // slice is the same for buffers and strings
    ret = list.head.data.slice(0, n);
    list.head.data = list.head.data.slice(n);
  } else if (n === list.head.data.length) {
    // first chunk is a perfect match
    ret = list.shift();
  } else {
    // result spans more than one buffer
    ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
  }
  return ret;
}

// Copies a specified amount of characters from the list of buffered data
// chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBufferString(n, list) {
  var p = list.head;
  var c = 1;
  var ret = p.data;
  n -= ret.length;
  while (p = p.next) {
    var str = p.data;
    var nb = n > str.length ? str.length : n;
    if (nb === str.length) ret += str;else ret += str.slice(0, n);
    n -= nb;
    if (n === 0) {
      if (nb === str.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = str.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

// Copies a specified amount of bytes from the list of buffered data chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBuffer(n, list) {
  var ret = Buffer.allocUnsafe(n);
  var p = list.head;
  var c = 1;
  p.data.copy(ret);
  n -= p.data.length;
  while (p = p.next) {
    var buf = p.data;
    var nb = n > buf.length ? buf.length : n;
    buf.copy(ret, ret.length - n, 0, nb);
    n -= nb;
    if (n === 0) {
      if (nb === buf.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = buf.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0) throw new Error('"endReadable()" called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    pna.nextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./_stream_duplex":128,"./internal/streams/BufferList":133,"./internal/streams/destroy":134,"./internal/streams/stream":135,"_process":122,"core-util-is":18,"events":21,"inherits":"inherits","isarray":25,"process-nextick-args":121,"safe-buffer":136,"string_decoder/":137,"util":16}],131:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);

function afterTransform(er, data) {
  var ts = this._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb) {
    return this.emit('error', new Error('write callback called multiple times'));
  }

  ts.writechunk = null;
  ts.writecb = null;

  if (data != null) // single equals check for both `null` and `undefined`
    this.push(data);

  cb(er);

  var rs = this._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    this._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);

  Duplex.call(this, options);

  this._transformState = {
    afterTransform: afterTransform.bind(this),
    needTransform: false,
    transforming: false,
    writecb: null,
    writechunk: null,
    writeencoding: null
  };

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;

    if (typeof options.flush === 'function') this._flush = options.flush;
  }

  // When the writable side finishes, then flush out anything remaining.
  this.on('prefinish', prefinish);
}

function prefinish() {
  var _this = this;

  if (typeof this._flush === 'function') {
    this._flush(function (er, data) {
      done(_this, er, data);
    });
  } else {
    done(this, null, null);
  }
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function (chunk, encoding, cb) {
  throw new Error('_transform() is not implemented');
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

Transform.prototype._destroy = function (err, cb) {
  var _this2 = this;

  Duplex.prototype._destroy.call(this, err, function (err2) {
    cb(err2);
    _this2.emit('close');
  });
};

function done(stream, er, data) {
  if (er) return stream.emit('error', er);

  if (data != null) // single equals check for both `null` and `undefined`
    stream.push(data);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  if (stream._writableState.length) throw new Error('Calling transform done when ws.length != 0');

  if (stream._transformState.transforming) throw new Error('Calling transform done when still transforming');

  return stream.push(null);
}
},{"./_stream_duplex":128,"core-util-is":18,"inherits":"inherits"}],132:[function(require,module,exports){
(function (process,global,setImmediate){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

module.exports = Writable;

/* <replacement> */
function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

// It seems a linked list but it is not
// there will be only 2 of these for each stream
function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;
  this.finish = function () {
    onCorkedFinish(_this, state);
  };
}
/* </replacement> */

/*<replacement>*/
var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : pna.nextTick;
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Writable.WritableState = WritableState;

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

/*<replacement>*/
var internalUtil = {
  deprecate: require('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/
var Stream = require('./internal/streams/stream');
/*</replacement>*/

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
var OurUint8Array = global.Uint8Array || function () {};
function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}
function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

/*</replacement>*/

var destroyImpl = require('./internal/streams/destroy');

util.inherits(Writable, Stream);

function nop() {}

function WritableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  var isDuplex = stream instanceof Duplex;

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (isDuplex) this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var writableHwm = options.writableHighWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;

  if (hwm || hwm === 0) this.highWaterMark = hwm;else if (isDuplex && (writableHwm || writableHwm === 0)) this.highWaterMark = writableHwm;else this.highWaterMark = defaultHwm;

  // cast to ints.
  this.highWaterMark = Math.floor(this.highWaterMark);

  // if _final has been called
  this.finalCalled = false;

  // drain event flag.
  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // has it been destroyed
  this.destroyed = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function (er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;

  // count buffered requests
  this.bufferedRequestCount = 0;

  // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two
  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function getBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function () {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.', 'DEP0003')
    });
  } catch (_) {}
})();

// Test _writableState for inheritance to account for Duplex streams,
// whose prototype chain only points to Readable.
var realHasInstance;
if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
  realHasInstance = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (object) {
      if (realHasInstance.call(this, object)) return true;
      if (this !== Writable) return false;

      return object && object._writableState instanceof WritableState;
    }
  });
} else {
  realHasInstance = function (object) {
    return object instanceof this;
  };
}

function Writable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.

  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.
  if (!realHasInstance.call(Writable, this) && !(this instanceof Duplex)) {
    return new Writable(options);
  }

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;

    if (typeof options.writev === 'function') this._writev = options.writev;

    if (typeof options.destroy === 'function') this._destroy = options.destroy;

    if (typeof options.final === 'function') this._final = options.final;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function () {
  this.emit('error', new Error('Cannot pipe, not readable'));
};

function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  pna.nextTick(cb, er);
}

// Checks that a user-supplied chunk is valid, especially for the particular
// mode the stream is in. Currently this means that `null` is never accepted
// and undefined/non-string values are only allowed in object mode.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  var er = false;

  if (chunk === null) {
    er = new TypeError('May not write null values to stream');
  } else if (typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  if (er) {
    stream.emit('error', er);
    pna.nextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;
  var isBuf = !state.objectMode && _isUint8Array(chunk);

  if (isBuf && !Buffer.isBuffer(chunk)) {
    chunk = _uint8ArrayToBuffer(chunk);
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (isBuf) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;

  if (typeof cb !== 'function') cb = nop;

  if (state.ended) writeAfterEnd(this, cb);else if (isBuf || validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function () {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = Buffer.from(chunk, encoding);
  }
  return chunk;
}

Object.defineProperty(Writable.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._writableState.highWaterMark;
  }
});

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {
  if (!isBuf) {
    var newChunk = decodeChunk(state, chunk, encoding);
    if (chunk !== newChunk) {
      isBuf = true;
      encoding = 'buffer';
      chunk = newChunk;
    }
  }
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = {
      chunk: chunk,
      encoding: encoding,
      isBuf: isBuf,
      callback: cb,
      next: null
    };
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;

  if (sync) {
    // defer the callback if we are being called synchronously
    // to avoid piling up things on the stack
    pna.nextTick(cb, er);
    // this can emit finish, and it will always happen
    // after error
    pna.nextTick(finishMaybe, stream, state);
    stream._writableState.errorEmitted = true;
    stream.emit('error', er);
  } else {
    // the caller expect this to happen before if
    // it is async
    cb(er);
    stream._writableState.errorEmitted = true;
    stream.emit('error', er);
    // this can emit finish, but finish must
    // always follow error
    finishMaybe(stream, state);
  }
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      /*<replacement>*/
      asyncWrite(afterWrite, stream, state, finished, cb);
      /*</replacement>*/
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}

// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;

    var count = 0;
    var allBuffers = true;
    while (entry) {
      buffer[count] = entry;
      if (!entry.isBuf) allBuffers = false;
      entry = entry.next;
      count += 1;
    }
    buffer.allBuffers = allBuffers;

    doWrite(stream, state, true, state.length, buffer, '', holder.finish);

    // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite
    state.pendingcb++;
    state.lastBufferedRequest = null;
    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }
    state.bufferedRequestCount = 0;
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      state.bufferedRequestCount--;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('_write() is not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished) endWritable(this, state, cb);
};

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}
function callFinal(stream, state) {
  stream._final(function (err) {
    state.pendingcb--;
    if (err) {
      stream.emit('error', err);
    }
    state.prefinished = true;
    stream.emit('prefinish');
    finishMaybe(stream, state);
  });
}
function prefinish(stream, state) {
  if (!state.prefinished && !state.finalCalled) {
    if (typeof stream._final === 'function') {
      state.pendingcb++;
      state.finalCalled = true;
      pna.nextTick(callFinal, stream, state);
    } else {
      state.prefinished = true;
      stream.emit('prefinish');
    }
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      state.finished = true;
      stream.emit('finish');
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished) pna.nextTick(cb);else stream.once('finish', cb);
  }
  state.ended = true;
  stream.writable = false;
}

function onCorkedFinish(corkReq, state, err) {
  var entry = corkReq.entry;
  corkReq.entry = null;
  while (entry) {
    var cb = entry.callback;
    state.pendingcb--;
    cb(err);
    entry = entry.next;
  }
  if (state.corkedRequestsFree) {
    state.corkedRequestsFree.next = corkReq;
  } else {
    state.corkedRequestsFree = corkReq;
  }
}

Object.defineProperty(Writable.prototype, 'destroyed', {
  get: function () {
    if (this._writableState === undefined) {
      return false;
    }
    return this._writableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._writableState) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._writableState.destroyed = value;
  }
});

Writable.prototype.destroy = destroyImpl.destroy;
Writable.prototype._undestroy = destroyImpl.undestroy;
Writable.prototype._destroy = function (err, cb) {
  this.end();
  cb(err);
};
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("timers").setImmediate)
},{"./_stream_duplex":128,"./internal/streams/destroy":134,"./internal/streams/stream":135,"_process":122,"core-util-is":18,"inherits":"inherits","process-nextick-args":121,"safe-buffer":136,"timers":146,"util-deprecate":149}],133:[function(require,module,exports){
'use strict';

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Buffer = require('safe-buffer').Buffer;
var util = require('util');

function copyBuffer(src, target, offset) {
  src.copy(target, offset);
}

module.exports = function () {
  function BufferList() {
    _classCallCheck(this, BufferList);

    this.head = null;
    this.tail = null;
    this.length = 0;
  }

  BufferList.prototype.push = function push(v) {
    var entry = { data: v, next: null };
    if (this.length > 0) this.tail.next = entry;else this.head = entry;
    this.tail = entry;
    ++this.length;
  };

  BufferList.prototype.unshift = function unshift(v) {
    var entry = { data: v, next: this.head };
    if (this.length === 0) this.tail = entry;
    this.head = entry;
    ++this.length;
  };

  BufferList.prototype.shift = function shift() {
    if (this.length === 0) return;
    var ret = this.head.data;
    if (this.length === 1) this.head = this.tail = null;else this.head = this.head.next;
    --this.length;
    return ret;
  };

  BufferList.prototype.clear = function clear() {
    this.head = this.tail = null;
    this.length = 0;
  };

  BufferList.prototype.join = function join(s) {
    if (this.length === 0) return '';
    var p = this.head;
    var ret = '' + p.data;
    while (p = p.next) {
      ret += s + p.data;
    }return ret;
  };

  BufferList.prototype.concat = function concat(n) {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length === 1) return this.head.data;
    var ret = Buffer.allocUnsafe(n >>> 0);
    var p = this.head;
    var i = 0;
    while (p) {
      copyBuffer(p.data, ret, i);
      i += p.data.length;
      p = p.next;
    }
    return ret;
  };

  return BufferList;
}();

if (util && util.inspect && util.inspect.custom) {
  module.exports.prototype[util.inspect.custom] = function () {
    var obj = util.inspect({ length: this.length });
    return this.constructor.name + ' ' + obj;
  };
}
},{"safe-buffer":136,"util":16}],134:[function(require,module,exports){
'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

// undocumented cb() API, needed for core, not for public API
function destroy(err, cb) {
  var _this = this;

  var readableDestroyed = this._readableState && this._readableState.destroyed;
  var writableDestroyed = this._writableState && this._writableState.destroyed;

  if (readableDestroyed || writableDestroyed) {
    if (cb) {
      cb(err);
    } else if (err && (!this._writableState || !this._writableState.errorEmitted)) {
      pna.nextTick(emitErrorNT, this, err);
    }
    return this;
  }

  // we set destroyed to true before firing error callbacks in order
  // to make it re-entrance safe in case destroy() is called within callbacks

  if (this._readableState) {
    this._readableState.destroyed = true;
  }

  // if this is a duplex stream mark the writable part as destroyed as well
  if (this._writableState) {
    this._writableState.destroyed = true;
  }

  this._destroy(err || null, function (err) {
    if (!cb && err) {
      pna.nextTick(emitErrorNT, _this, err);
      if (_this._writableState) {
        _this._writableState.errorEmitted = true;
      }
    } else if (cb) {
      cb(err);
    }
  });

  return this;
}

function undestroy() {
  if (this._readableState) {
    this._readableState.destroyed = false;
    this._readableState.reading = false;
    this._readableState.ended = false;
    this._readableState.endEmitted = false;
  }

  if (this._writableState) {
    this._writableState.destroyed = false;
    this._writableState.ended = false;
    this._writableState.ending = false;
    this._writableState.finished = false;
    this._writableState.errorEmitted = false;
  }
}

function emitErrorNT(self, err) {
  self.emit('error', err);
}

module.exports = {
  destroy: destroy,
  undestroy: undestroy
};
},{"process-nextick-args":121}],135:[function(require,module,exports){
module.exports = require('events').EventEmitter;

},{"events":21}],136:[function(require,module,exports){
/* eslint-disable node/no-deprecated-api */
var buffer = require('buffer')
var Buffer = buffer.Buffer

// alternative to using Object.keys for old browsers
function copyProps (src, dst) {
  for (var key in src) {
    dst[key] = src[key]
  }
}
if (Buffer.from && Buffer.alloc && Buffer.allocUnsafe && Buffer.allocUnsafeSlow) {
  module.exports = buffer
} else {
  // Copy properties from require('buffer')
  copyProps(buffer, exports)
  exports.Buffer = SafeBuffer
}

function SafeBuffer (arg, encodingOrOffset, length) {
  return Buffer(arg, encodingOrOffset, length)
}

// Copy static methods from Buffer
copyProps(Buffer, SafeBuffer)

SafeBuffer.from = function (arg, encodingOrOffset, length) {
  if (typeof arg === 'number') {
    throw new TypeError('Argument must not be a number')
  }
  return Buffer(arg, encodingOrOffset, length)
}

SafeBuffer.alloc = function (size, fill, encoding) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  var buf = Buffer(size)
  if (fill !== undefined) {
    if (typeof encoding === 'string') {
      buf.fill(fill, encoding)
    } else {
      buf.fill(fill)
    }
  } else {
    buf.fill(0)
  }
  return buf
}

SafeBuffer.allocUnsafe = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return Buffer(size)
}

SafeBuffer.allocUnsafeSlow = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return buffer.SlowBuffer(size)
}

},{"buffer":17}],137:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
/*</replacement>*/

var isEncoding = Buffer.isEncoding || function (encoding) {
  encoding = '' + encoding;
  switch (encoding && encoding.toLowerCase()) {
    case 'hex':case 'utf8':case 'utf-8':case 'ascii':case 'binary':case 'base64':case 'ucs2':case 'ucs-2':case 'utf16le':case 'utf-16le':case 'raw':
      return true;
    default:
      return false;
  }
};

function _normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  var retried;
  while (true) {
    switch (enc) {
      case 'utf8':
      case 'utf-8':
        return 'utf8';
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return 'utf16le';
      case 'latin1':
      case 'binary':
        return 'latin1';
      case 'base64':
      case 'ascii':
      case 'hex':
        return enc;
      default:
        if (retried) return; // undefined
        enc = ('' + enc).toLowerCase();
        retried = true;
    }
  }
};

// Do not cache `Buffer.isEncoding` when checking encoding names as some
// modules monkey-patch it to support additional encodings
function normalizeEncoding(enc) {
  var nenc = _normalizeEncoding(enc);
  if (typeof nenc !== 'string' && (Buffer.isEncoding === isEncoding || !isEncoding(enc))) throw new Error('Unknown encoding: ' + enc);
  return nenc || enc;
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters.
exports.StringDecoder = StringDecoder;
function StringDecoder(encoding) {
  this.encoding = normalizeEncoding(encoding);
  var nb;
  switch (this.encoding) {
    case 'utf16le':
      this.text = utf16Text;
      this.end = utf16End;
      nb = 4;
      break;
    case 'utf8':
      this.fillLast = utf8FillLast;
      nb = 4;
      break;
    case 'base64':
      this.text = base64Text;
      this.end = base64End;
      nb = 3;
      break;
    default:
      this.write = simpleWrite;
      this.end = simpleEnd;
      return;
  }
  this.lastNeed = 0;
  this.lastTotal = 0;
  this.lastChar = Buffer.allocUnsafe(nb);
}

StringDecoder.prototype.write = function (buf) {
  if (buf.length === 0) return '';
  var r;
  var i;
  if (this.lastNeed) {
    r = this.fillLast(buf);
    if (r === undefined) return '';
    i = this.lastNeed;
    this.lastNeed = 0;
  } else {
    i = 0;
  }
  if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
  return r || '';
};

StringDecoder.prototype.end = utf8End;

// Returns only complete characters in a Buffer
StringDecoder.prototype.text = utf8Text;

// Attempts to complete a partial non-UTF-8 character using bytes from a Buffer
StringDecoder.prototype.fillLast = function (buf) {
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
  this.lastNeed -= buf.length;
};

// Checks the type of a UTF-8 byte, whether it's ASCII, a leading byte, or a
// continuation byte. If an invalid byte is detected, -2 is returned.
function utf8CheckByte(byte) {
  if (byte <= 0x7F) return 0;else if (byte >> 5 === 0x06) return 2;else if (byte >> 4 === 0x0E) return 3;else if (byte >> 3 === 0x1E) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

// Checks at most 3 bytes at the end of a Buffer in order to detect an
// incomplete multi-byte UTF-8 character. The total number of bytes (2, 3, or 4)
// needed to complete the UTF-8 character (if applicable) are returned.
function utf8CheckIncomplete(self, buf, i) {
  var j = buf.length - 1;
  if (j < i) return 0;
  var nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

// Validates as many continuation bytes for a multi-byte UTF-8 character as
// needed or are available. If we see a non-continuation byte where we expect
// one, we "replace" the validated continuation bytes we've seen so far with
// a single UTF-8 replacement character ('\ufffd'), to match v8's UTF-8 decoding
// behavior. The continuation byte check is included three times in the case
// where all of the continuation bytes for a character exist in the same buffer.
// It is also done this way as a slight performance increase instead of using a
// loop.
function utf8CheckExtraBytes(self, buf, p) {
  if ((buf[0] & 0xC0) !== 0x80) {
    self.lastNeed = 0;
    return '\ufffd';
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xC0) !== 0x80) {
      self.lastNeed = 1;
      return '\ufffd';
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xC0) !== 0x80) {
        self.lastNeed = 2;
        return '\ufffd';
      }
    }
  }
}

// Attempts to complete a multi-byte UTF-8 character using bytes from a Buffer.
function utf8FillLast(buf) {
  var p = this.lastTotal - this.lastNeed;
  var r = utf8CheckExtraBytes(this, buf, p);
  if (r !== undefined) return r;
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, p, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, p, 0, buf.length);
  this.lastNeed -= buf.length;
}

// Returns all complete UTF-8 characters in a Buffer. If the Buffer ended on a
// partial character, the character's bytes are buffered until the required
// number of bytes are available.
function utf8Text(buf, i) {
  var total = utf8CheckIncomplete(this, buf, i);
  if (!this.lastNeed) return buf.toString('utf8', i);
  this.lastTotal = total;
  var end = buf.length - (total - this.lastNeed);
  buf.copy(this.lastChar, 0, end);
  return buf.toString('utf8', i, end);
}

// For UTF-8, a replacement character is added when ending on a partial
// character.
function utf8End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + '\ufffd';
  return r;
}

// UTF-16LE typically needs two bytes per character, but even if we have an even
// number of bytes available, we need to check if we end on a leading/high
// surrogate. In that case, we need to wait for the next two bytes in order to
// decode the last character properly.
function utf16Text(buf, i) {
  if ((buf.length - i) % 2 === 0) {
    var r = buf.toString('utf16le', i);
    if (r) {
      var c = r.charCodeAt(r.length - 1);
      if (c >= 0xD800 && c <= 0xDBFF) {
        this.lastNeed = 2;
        this.lastTotal = 4;
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  this.lastNeed = 1;
  this.lastTotal = 2;
  this.lastChar[0] = buf[buf.length - 1];
  return buf.toString('utf16le', i, buf.length - 1);
}

// For UTF-16LE we do not explicitly append special replacement characters if we
// end on a partial character, we simply let v8 handle that.
function utf16End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) {
    var end = this.lastTotal - this.lastNeed;
    return r + this.lastChar.toString('utf16le', 0, end);
  }
  return r;
}

function base64Text(buf, i) {
  var n = (buf.length - i) % 3;
  if (n === 0) return buf.toString('base64', i);
  this.lastNeed = 3 - n;
  this.lastTotal = 3;
  if (n === 1) {
    this.lastChar[0] = buf[buf.length - 1];
  } else {
    this.lastChar[0] = buf[buf.length - 2];
    this.lastChar[1] = buf[buf.length - 1];
  }
  return buf.toString('base64', i, buf.length - n);
}

function base64End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + this.lastChar.toString('base64', 0, 3 - this.lastNeed);
  return r;
}

// Pass bytes on through for single-byte encodings (e.g. ascii, latin1, hex)
function simpleWrite(buf) {
  return buf.toString(this.encoding);
}

function simpleEnd(buf) {
  return buf && buf.length ? this.write(buf) : '';
}
},{"safe-buffer":136}],138:[function(require,module,exports){
module.exports = require('./readable').PassThrough

},{"./readable":139}],139:[function(require,module,exports){
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = exports;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":128,"./lib/_stream_passthrough.js":129,"./lib/_stream_readable.js":130,"./lib/_stream_transform.js":131,"./lib/_stream_writable.js":132}],140:[function(require,module,exports){
module.exports = require('./readable').Transform

},{"./readable":139}],141:[function(require,module,exports){
module.exports = require('./lib/_stream_writable.js');

},{"./lib/_stream_writable.js":132}],142:[function(require,module,exports){
var EventEmitter = require('events').EventEmitter
var backoff = require('backoff')

module.exports =
function (createConnection) {
  return function (opts, onConnect) {
    onConnect = 'function' == typeof opts ? opts : onConnect
    opts = 'object' == typeof opts ? opts : {initialDelay: 1e3, maxDelay: 30e3}
    if(!onConnect)
      onConnect = opts.onConnect

    var emitter = new EventEmitter()
    emitter.connected = false
    emitter.reconnect = true

    if(onConnect)
      //use "connection" to match core (net) api.
      emitter.on('connection', onConnect)

    var backoffMethod = (backoff[opts.type] || backoff.fibonacci) (opts)

    if(opts.failAfter)
      backoffMethod.failAfter(opts.failAfter);

    backoffMethod.on('backoff', function (n, d, e) {
      emitter.emit('backoff', n, d, e)
    })
    backoffMethod.on('fail', function (e) {
      emitter.disconnect()
      emitter.emit('fail', e)
    })

    var args
    function attempt (n, delay) {
      if(emitter.connected) return
      if(!emitter.reconnect) return

      emitter.emit('reconnect', n, delay)
      var con = createConnection.apply(emitter, args)
      emitter._connection = con

      function onError (err) {
        con.removeListener('error', onError)
        try
        {
          emitter.emit('error', err)
        }
        catch(e){}
        onDisconnect(err)
      }

      function onDisconnect (err) {
        emitter.connected = false
        con.removeListener('close', onDisconnect)
        con.removeListener('end'  , onDisconnect)

        //hack to make http not crash.
        //HTTP IS THE WORST PROTOCOL.
        if(con.constructor.name == 'Request')
          con.on('error', function () {})

        //emit disconnect before checking reconnect, so user has a chance to decide not to.
        emitter.emit('disconnect', err)

        if(!emitter.reconnect) return
        try { backoffMethod.backoff(err) } catch (_) { }
      }

      con
        .on('error', onError)
        .on('close', onDisconnect)
        .on('end'  , onDisconnect)

        function emitConnect()
        {
          emitter.connected = true
          emitter.emit('connection', con)
          emitter.emit('connect', con)
        }

      if(opts.immediate || con.constructor.name == 'Request') {
        emitConnect()

        con.once('data', function () {
          //this is the only way to know for sure that data is coming...
          backoffMethod.reset()
        })
      } else {
        con
          .once('connect', function () {
            backoffMethod.reset()

            if(onConnect)
              con.removeListener('connect', onConnect)

            emitConnect()
          })
      }
    }

    emitter.connect =
    emitter.listen = function () {
      this.reconnect = true
      if(emitter.connected) return
      backoffMethod.reset()
      backoffMethod.on('ready', attempt)
      args = args || [].slice.call(arguments)
      attempt(0, 0)
      return emitter
    }

    //force reconnection

    emitter.disconnect = function () {
      this.reconnect = false

      if(emitter._connection)
        emitter._connection.end()

      return emitter
    }

    return emitter
  }

}

},{"backoff":9,"events":21}],143:[function(require,module,exports){
var websocket = require('websocket-stream');
var inject = require('reconnect-core');

module.exports = inject(function () {
  // Create new websocket-stream instance
  var args = [].slice.call(arguments);
  var ws = websocket.apply(null, args);

  // Copy buffer from old websocket-stream instance on the new one
  var prevCon = this.prevCon;
  if(prevCon && prevCon._buffer)
    ws._buffer = prevCon._buffer;
  this.prevCon = ws;

  // Return new websocket-stream instance
  return ws;
});

},{"reconnect-core":142,"websocket-stream":152}],144:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

module.exports = Stream;

var EE = require('events').EventEmitter;
var inherits = require('inherits');

inherits(Stream, EE);
Stream.Readable = require('readable-stream/readable.js');
Stream.Writable = require('readable-stream/writable.js');
Stream.Duplex = require('readable-stream/duplex.js');
Stream.Transform = require('readable-stream/transform.js');
Stream.PassThrough = require('readable-stream/passthrough.js');

// Backwards-compat with node 0.4.x
Stream.Stream = Stream;



// old-style streams.  Note that the pipe method (the only relevant
// part of this class) is overridden in the Readable class.

function Stream() {
  EE.call(this);
}

Stream.prototype.pipe = function(dest, options) {
  var source = this;

  function ondata(chunk) {
    if (dest.writable) {
      if (false === dest.write(chunk) && source.pause) {
        source.pause();
      }
    }
  }

  source.on('data', ondata);

  function ondrain() {
    if (source.readable && source.resume) {
      source.resume();
    }
  }

  dest.on('drain', ondrain);

  // If the 'end' option is not supplied, dest.end() will be called when
  // source gets the 'end' or 'close' events.  Only dest.end() once.
  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
    source.on('close', onclose);
  }

  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;

    dest.end();
  }


  function onclose() {
    if (didOnEnd) return;
    didOnEnd = true;

    if (typeof dest.destroy === 'function') dest.destroy();
  }

  // don't leave dangling pipes when there are errors.
  function onerror(er) {
    cleanup();
    if (EE.listenerCount(this, 'error') === 0) {
      throw er; // Unhandled stream error in pipe.
    }
  }

  source.on('error', onerror);
  dest.on('error', onerror);

  // remove all the event listeners that were added.
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);

    source.removeListener('end', onend);
    source.removeListener('close', onclose);

    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);

    source.removeListener('end', cleanup);
    source.removeListener('close', cleanup);

    dest.removeListener('close', cleanup);
  }

  source.on('end', cleanup);
  source.on('close', cleanup);

  dest.on('close', cleanup);

  dest.emit('pipe', source);

  // Allow for unix-like usage: A.pipe(B).pipe(C)
  return dest;
};

},{"events":21,"inherits":"inherits","readable-stream/duplex.js":127,"readable-stream/passthrough.js":138,"readable-stream/readable.js":139,"readable-stream/transform.js":140,"readable-stream/writable.js":141}],145:[function(require,module,exports){
(function (process){
var Stream = require('stream')

// through
//
// a stream that does nothing but re-emit the input.
// useful for aggregating a series of changing but not ending streams into one stream)

exports = module.exports = through
through.through = through

//create a readable writable stream.

function through (write, end, opts) {
  write = write || function (data) { this.queue(data) }
  end = end || function () { this.queue(null) }

  var ended = false, destroyed = false, buffer = [], _ended = false
  var stream = new Stream()
  stream.readable = stream.writable = true
  stream.paused = false

//  stream.autoPause   = !(opts && opts.autoPause   === false)
  stream.autoDestroy = !(opts && opts.autoDestroy === false)

  stream.write = function (data) {
    write.call(this, data)
    return !stream.paused
  }

  function drain() {
    while(buffer.length && !stream.paused) {
      var data = buffer.shift()
      if(null === data)
        return stream.emit('end')
      else
        stream.emit('data', data)
    }
  }

  stream.queue = stream.push = function (data) {
//    console.error(ended)
    if(_ended) return stream
    if(data === null) _ended = true
    buffer.push(data)
    drain()
    return stream
  }

  //this will be registered as the first 'end' listener
  //must call destroy next tick, to make sure we're after any
  //stream piped from here.
  //this is only a problem if end is not emitted synchronously.
  //a nicer way to do this is to make sure this is the last listener for 'end'

  stream.on('end', function () {
    stream.readable = false
    if(!stream.writable && stream.autoDestroy)
      process.nextTick(function () {
        stream.destroy()
      })
  })

  function _end () {
    stream.writable = false
    end.call(stream)
    if(!stream.readable && stream.autoDestroy)
      stream.destroy()
  }

  stream.end = function (data) {
    if(ended) return
    ended = true
    if(arguments.length) stream.write(data)
    _end() // will emit or queue
    return stream
  }

  stream.destroy = function () {
    if(destroyed) return
    destroyed = true
    ended = true
    buffer.length = 0
    stream.writable = stream.readable = false
    stream.emit('close')
    return stream
  }

  stream.pause = function () {
    if(stream.paused) return
    stream.paused = true
    return stream
  }

  stream.resume = function () {
    if(stream.paused) {
      stream.paused = false
      stream.emit('resume')
    }
    drain()
    //may have become paused again,
    //as drain emits 'data'.
    if(!stream.paused)
      stream.emit('drain')
    return stream
  }
  return stream
}


}).call(this,require('_process'))
},{"_process":122,"stream":144}],146:[function(require,module,exports){
(function (setImmediate,clearImmediate){
var nextTick = require('process/browser.js').nextTick;
var apply = Function.prototype.apply;
var slice = Array.prototype.slice;
var immediateIds = {};
var nextImmediateId = 0;

// DOM APIs, for completeness

exports.setTimeout = function() {
  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
};
exports.setInterval = function() {
  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
};
exports.clearTimeout =
exports.clearInterval = function(timeout) { timeout.close(); };

function Timeout(id, clearFn) {
  this._id = id;
  this._clearFn = clearFn;
}
Timeout.prototype.unref = Timeout.prototype.ref = function() {};
Timeout.prototype.close = function() {
  this._clearFn.call(window, this._id);
};

// Does not start the time, just sets up the members needed.
exports.enroll = function(item, msecs) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
};

exports.unenroll = function(item) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
};

exports._unrefActive = exports.active = function(item) {
  clearTimeout(item._idleTimeoutId);

  var msecs = item._idleTimeout;
  if (msecs >= 0) {
    item._idleTimeoutId = setTimeout(function onTimeout() {
      if (item._onTimeout)
        item._onTimeout();
    }, msecs);
  }
};

// That's not how node.js implements it but the exposed api is the same.
exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
  var id = nextImmediateId++;
  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

  immediateIds[id] = true;

  nextTick(function onNextTick() {
    if (immediateIds[id]) {
      // fn.call() is faster so we optimize for the common use-case
      // @see http://jsperf.com/call-apply-segu
      if (args) {
        fn.apply(null, args);
      } else {
        fn.call(null);
      }
      // Prevent ids from leaking
      exports.clearImmediate(id);
    }
  });

  return id;
};

exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
  delete immediateIds[id];
};
}).call(this,require("timers").setImmediate,require("timers").clearImmediate)
},{"process/browser.js":122,"timers":146}],147:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

var punycode = require('punycode');
var util = require('./util');

exports.parse = urlParse;
exports.resolve = urlResolve;
exports.resolveObject = urlResolveObject;
exports.format = urlFormat;

exports.Url = Url;

function Url() {
  this.protocol = null;
  this.slashes = null;
  this.auth = null;
  this.host = null;
  this.port = null;
  this.hostname = null;
  this.hash = null;
  this.search = null;
  this.query = null;
  this.pathname = null;
  this.path = null;
  this.href = null;
}

// Reference: RFC 3986, RFC 1808, RFC 2396

// define these here so at least they only have to be
// compiled once on the first module load.
var protocolPattern = /^([a-z0-9.+-]+:)/i,
    portPattern = /:[0-9]*$/,

    // Special case for a simple path URL
    simplePathPattern = /^(\/\/?(?!\/)[^\?\s]*)(\?[^\s]*)?$/,

    // RFC 2396: characters reserved for delimiting URLs.
    // We actually just auto-escape these.
    delims = ['<', '>', '"', '`', ' ', '\r', '\n', '\t'],

    // RFC 2396: characters not allowed for various reasons.
    unwise = ['{', '}', '|', '\\', '^', '`'].concat(delims),

    // Allowed by RFCs, but cause of XSS attacks.  Always escape these.
    autoEscape = ['\''].concat(unwise),
    // Characters that are never ever allowed in a hostname.
    // Note that any invalid chars are also handled, but these
    // are the ones that are *expected* to be seen, so we fast-path
    // them.
    nonHostChars = ['%', '/', '?', ';', '#'].concat(autoEscape),
    hostEndingChars = ['/', '?', '#'],
    hostnameMaxLen = 255,
    hostnamePartPattern = /^[+a-z0-9A-Z_-]{0,63}$/,
    hostnamePartStart = /^([+a-z0-9A-Z_-]{0,63})(.*)$/,
    // protocols that can allow "unsafe" and "unwise" chars.
    unsafeProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that never have a hostname.
    hostlessProtocol = {
      'javascript': true,
      'javascript:': true
    },
    // protocols that always contain a // bit.
    slashedProtocol = {
      'http': true,
      'https': true,
      'ftp': true,
      'gopher': true,
      'file': true,
      'http:': true,
      'https:': true,
      'ftp:': true,
      'gopher:': true,
      'file:': true
    },
    querystring = require('querystring');

function urlParse(url, parseQueryString, slashesDenoteHost) {
  if (url && util.isObject(url) && url instanceof Url) return url;

  var u = new Url;
  u.parse(url, parseQueryString, slashesDenoteHost);
  return u;
}

Url.prototype.parse = function(url, parseQueryString, slashesDenoteHost) {
  if (!util.isString(url)) {
    throw new TypeError("Parameter 'url' must be a string, not " + typeof url);
  }

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  var queryIndex = url.indexOf('?'),
      splitter =
          (queryIndex !== -1 && queryIndex < url.indexOf('#')) ? '?' : '#',
      uSplit = url.split(splitter),
      slashRegex = /\\/g;
  uSplit[0] = uSplit[0].replace(slashRegex, '/');
  url = uSplit.join(splitter);

  var rest = url;

  // trim before proceeding.
  // This is to support parse stuff like "  http://foo.com  \n"
  rest = rest.trim();

  if (!slashesDenoteHost && url.split('#').length === 1) {
    // Try fast path regexp
    var simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = querystring.parse(this.search.substr(1));
        } else {
          this.query = this.search.substr(1);
        }
      } else if (parseQueryString) {
        this.search = '';
        this.query = {};
      }
      return this;
    }
  }

  var proto = protocolPattern.exec(rest);
  if (proto) {
    proto = proto[0];
    var lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substr(proto.length);
  }

  // figure out if it's got a host
  // user@server is *always* interpreted as a hostname, and url
  // resolution will treat //foo/bar as host=foo,path=bar because that's
  // how the browser resolves relative URLs.
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@\/]+@[^@\/]+/)) {
    var slashes = rest.substr(0, 2) === '//';
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substr(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] &&
      (slashes || (proto && !slashedProtocol[proto]))) {

    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.
    // URLs are obnoxious.
    //
    // ex:
    // http://a@b@c/ => user:a@b host:c
    // http://a@b?@c => user:a host:c path:/?@c

    // v0.12 TODO(isaacs): This is not quite how Chrome does things.
    // Review our test case against browsers more comprehensively.

    // find the first instance of any hostEndingChars
    var hostEnd = -1;
    for (var i = 0; i < hostEndingChars.length; i++) {
      var hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    var auth, atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf('@');
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf('@', hostEnd);
    }

    // Now we have a portion which is definitely the auth.
    // Pull that off.
    if (atSign !== -1) {
      auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (var i = 0; i < nonHostChars.length; i++) {
      var hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd))
        hostEnd = hec;
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1)
      hostEnd = rest.length;

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // we've indicated that there is a hostname,
    // so even if it's empty, it has to be present.
    this.hostname = this.hostname || '';

    // if hostname begins with [ and ends with ]
    // assume that it's an IPv6 address.
    var ipv6Hostname = this.hostname[0] === '[' &&
        this.hostname[this.hostname.length - 1] === ']';

    // validate a little.
    if (!ipv6Hostname) {
      var hostparts = this.hostname.split(/\./);
      for (var i = 0, l = hostparts.length; i < l; i++) {
        var part = hostparts[i];
        if (!part) continue;
        if (!part.match(hostnamePartPattern)) {
          var newpart = '';
          for (var j = 0, k = part.length; j < k; j++) {
            if (part.charCodeAt(j) > 127) {
              // we replace non-ASCII char with a temporary placeholder
              // we need this to make sure size of hostname is not
              // broken by replacing non-ASCII by nothing
              newpart += 'x';
            } else {
              newpart += part[j];
            }
          }
          // we test again with ASCII char only
          if (!newpart.match(hostnamePartPattern)) {
            var validParts = hostparts.slice(0, i);
            var notHost = hostparts.slice(i + 1);
            var bit = part.match(hostnamePartStart);
            if (bit) {
              validParts.push(bit[1]);
              notHost.unshift(bit[2]);
            }
            if (notHost.length) {
              rest = '/' + notHost.join('.') + rest;
            }
            this.hostname = validParts.join('.');
            break;
          }
        }
      }
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = '';
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    if (!ipv6Hostname) {
      // IDNA Support: Returns a punycoded representation of "domain".
      // It only converts parts of the domain name that
      // have non-ASCII characters, i.e. it doesn't matter if
      // you call it with a domain that already is ASCII-only.
      this.hostname = punycode.toASCII(this.hostname);
    }

    var p = this.port ? ':' + this.port : '';
    var h = this.hostname || '';
    this.host = h + p;
    this.href += this.host;

    // strip [ and ] from the hostname
    // the host field still retains them, though
    if (ipv6Hostname) {
      this.hostname = this.hostname.substr(1, this.hostname.length - 2);
      if (rest[0] !== '/') {
        rest = '/' + rest;
      }
    }
  }

  // now rest is set to the post-host stuff.
  // chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {

    // First, make 100% sure that any "autoEscape" chars get
    // escaped, even if encodeURIComponent doesn't think they
    // need to be.
    for (var i = 0, l = autoEscape.length; i < l; i++) {
      var ae = autoEscape[i];
      if (rest.indexOf(ae) === -1)
        continue;
      var esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }


  // chop off from the tail first.
  var hash = rest.indexOf('#');
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substr(hash);
    rest = rest.slice(0, hash);
  }
  var qm = rest.indexOf('?');
  if (qm !== -1) {
    this.search = rest.substr(qm);
    this.query = rest.substr(qm + 1);
    if (parseQueryString) {
      this.query = querystring.parse(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = '';
    this.query = {};
  }
  if (rest) this.pathname = rest;
  if (slashedProtocol[lowerProto] &&
      this.hostname && !this.pathname) {
    this.pathname = '/';
  }

  //to support http.request
  if (this.pathname || this.search) {
    var p = this.pathname || '';
    var s = this.search || '';
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

// format a parsed object into a url string
function urlFormat(obj) {
  // ensure it's an object, and not a string url.
  // If it's an obj, this is a no-op.
  // this way, you can call url_format() on strings
  // to clean up potentially wonky urls.
  if (util.isString(obj)) obj = urlParse(obj);
  if (!(obj instanceof Url)) return Url.prototype.format.call(obj);
  return obj.format();
}

Url.prototype.format = function() {
  var auth = this.auth || '';
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ':');
    auth += '@';
  }

  var protocol = this.protocol || '',
      pathname = this.pathname || '',
      hash = this.hash || '',
      host = false,
      query = '';

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(':') === -1 ?
        this.hostname :
        '[' + this.hostname + ']');
    if (this.port) {
      host += ':' + this.port;
    }
  }

  if (this.query &&
      util.isObject(this.query) &&
      Object.keys(this.query).length) {
    query = querystring.stringify(this.query);
  }

  var search = this.search || (query && ('?' + query)) || '';

  if (protocol && protocol.substr(-1) !== ':') protocol += ':';

  // only the slashedProtocols get the //.  Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes ||
      (!protocol || slashedProtocol[protocol]) && host !== false) {
    host = '//' + (host || '');
    if (pathname && pathname.charAt(0) !== '/') pathname = '/' + pathname;
  } else if (!host) {
    host = '';
  }

  if (hash && hash.charAt(0) !== '#') hash = '#' + hash;
  if (search && search.charAt(0) !== '?') search = '?' + search;

  pathname = pathname.replace(/[?#]/g, function(match) {
    return encodeURIComponent(match);
  });
  search = search.replace('#', '%23');

  return protocol + host + pathname + search + hash;
};

function urlResolve(source, relative) {
  return urlParse(source, false, true).resolve(relative);
}

Url.prototype.resolve = function(relative) {
  return this.resolveObject(urlParse(relative, false, true)).format();
};

function urlResolveObject(source, relative) {
  if (!source) return relative;
  return urlParse(source, false, true).resolveObject(relative);
}

Url.prototype.resolveObject = function(relative) {
  if (util.isString(relative)) {
    var rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  var result = new Url();
  var tkeys = Object.keys(this);
  for (var tk = 0; tk < tkeys.length; tk++) {
    var tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what.
  // even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === '') {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    var rkeys = Object.keys(relative);
    for (var rk = 0; rk < rkeys.length; rk++) {
      var rkey = rkeys[rk];
      if (rkey !== 'protocol')
        result[rkey] = relative[rkey];
    }

    //urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] &&
        result.hostname && !result.pathname) {
      result.path = result.pathname = '/';
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing
    // the protocol does weird things
    // first, if it's not file:, then we MUST have a host,
    // and if there was a path
    // to begin with, then we MUST have a path.
    // if it is file:, then the host is dropped,
    // because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      var keys = Object.keys(relative);
      for (var v = 0; v < keys.length; v++) {
        var k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (!relative.host && !hostlessProtocol[relative.protocol]) {
      var relPath = (relative.pathname || '').split('/');
      while (relPath.length && !(relative.host = relPath.shift()));
      if (!relative.host) relative.host = '';
      if (!relative.hostname) relative.hostname = '';
      if (relPath[0] !== '') relPath.unshift('');
      if (relPath.length < 2) relPath.unshift('');
      result.pathname = relPath.join('/');
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || '';
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      var p = result.pathname || '';
      var s = result.search || '';
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  var isSourceAbs = (result.pathname && result.pathname.charAt(0) === '/'),
      isRelAbs = (
          relative.host ||
          relative.pathname && relative.pathname.charAt(0) === '/'
      ),
      mustEndAbs = (isRelAbs || isSourceAbs ||
                    (result.host && relative.pathname)),
      removeAllDots = mustEndAbs,
      srcPath = result.pathname && result.pathname.split('/') || [],
      relPath = relative.pathname && relative.pathname.split('/') || [],
      psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative
  // links like ../.. should be able
  // to crawl up to the hostname, as well.  This is strange.
  // result.protocol has already been set by now.
  // Later on, put the first path part into the host field.
  if (psychotic) {
    result.hostname = '';
    result.port = null;
    if (result.host) {
      if (srcPath[0] === '') srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = '';
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      if (relative.host) {
        if (relPath[0] === '') relPath[0] = relative.host;
        else relPath.unshift(relative.host);
      }
      relative.host = null;
    }
    mustEndAbs = mustEndAbs && (relPath[0] === '' || srcPath[0] === '');
  }

  if (isRelAbs) {
    // it's absolute.
    result.host = (relative.host || relative.host === '') ?
                  relative.host : result.host;
    result.hostname = (relative.hostname || relative.hostname === '') ?
                      relative.hostname : result.hostname;
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative
    // throw away the existing file, and take the new path instead.
    if (!srcPath) srcPath = [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (!util.isNullOrUndefined(relative.search)) {
    // just pull out the search.
    // like href='?foo'.
    // Put this after the other two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      //occationaly the auth can get stuck only in host
      //this especially happens in cases like
      //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
      var authInHost = result.host && result.host.indexOf('@') > 0 ?
                       result.host.split('@') : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.host = result.hostname = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    //to support http.request
    if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
      result.path = (result.pathname ? result.pathname : '') +
                    (result.search ? result.search : '');
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all.  easy.
    // we've already handled the other stuff above.
    result.pathname = null;
    //to support http.request
    if (result.search) {
      result.path = '/' + result.search;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  var last = srcPath.slice(-1)[0];
  var hasTrailingSlash = (
      (result.host || relative.host || srcPath.length > 1) &&
      (last === '.' || last === '..') || last === '');

  // strip single dots, resolve double dots to parent dir
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === '.') {
      srcPath.splice(i, 1);
    } else if (last === '..') {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift('..');
    }
  }

  if (mustEndAbs && srcPath[0] !== '' &&
      (!srcPath[0] || srcPath[0].charAt(0) !== '/')) {
    srcPath.unshift('');
  }

  if (hasTrailingSlash && (srcPath.join('/').substr(-1) !== '/')) {
    srcPath.push('');
  }

  var isAbsolute = srcPath[0] === '' ||
      (srcPath[0] && srcPath[0].charAt(0) === '/');

  // put the host back
  if (psychotic) {
    result.hostname = result.host = isAbsolute ? '' :
                                    srcPath.length ? srcPath.shift() : '';
    //occationaly the auth can get stuck only in host
    //this especially happens in cases like
    //url.resolveObject('mailto:local1@domain1', 'local2@domain2')
    var authInHost = result.host && result.host.indexOf('@') > 0 ?
                     result.host.split('@') : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.host = result.hostname = authInHost.shift();
    }
  }

  mustEndAbs = mustEndAbs || (result.host && srcPath.length);

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift('');
  }

  if (!srcPath.length) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join('/');
  }

  //to support request.http
  if (!util.isNull(result.pathname) || !util.isNull(result.search)) {
    result.path = (result.pathname ? result.pathname : '') +
                  (result.search ? result.search : '');
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function() {
  var host = this.host;
  var port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ':') {
      this.port = port.substr(1);
    }
    host = host.substr(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

},{"./util":148,"punycode":123,"querystring":126}],148:[function(require,module,exports){
'use strict';

module.exports = {
  isString: function(arg) {
    return typeof(arg) === 'string';
  },
  isObject: function(arg) {
    return typeof(arg) === 'object' && arg !== null;
  },
  isNull: function(arg) {
    return arg === null;
  },
  isNullOrUndefined: function(arg) {
    return arg == null;
  }
};

},{}],149:[function(require,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],150:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],151:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":150,"_process":122,"inherits":"inherits"}],152:[function(require,module,exports){
(function (process){
var through = require('through')
var isBuffer = require('isbuffer')
var WebSocketPoly = require('ws')

function WebsocketStream(server, options) {
  if (!(this instanceof WebsocketStream)) return new WebsocketStream(server, options)

  this.stream = through(this.write.bind(this), this.end.bind(this))

  this.stream.websocketStream = this
  this.options = options || {}
  this._buffer = []
 
  if (typeof server === "object") {
    this.ws = server
    this.ws.on('message', this.onMessage.bind(this))
    this.ws.on('error', this.onError.bind(this))
    this.ws.on('close', this.onClose.bind(this))
    this.ws.on('open', this.onOpen.bind(this))
    if (this.ws.readyState === 1) this._open = true
  } else {
    var opts = (process.title === 'browser') ? this.options.protocol : this.options
    this.ws = new WebSocketPoly(server, opts)
    this.ws.binaryType = this.options.binaryType || 'arraybuffer'
    this.ws.onmessage = this.onMessage.bind(this)
    this.ws.onerror = this.onError.bind(this)
    this.ws.onclose = this.onClose.bind(this)
    this.ws.onopen = this.onOpen.bind(this)
  }
  
  return this.stream
}

module.exports = WebsocketStream
module.exports.WebsocketStream = WebsocketStream

WebsocketStream.prototype.onMessage = function(e) {
  var data = e
  if (typeof data.data !== 'undefined') data = data.data

  // type must be a Typed Array (ArrayBufferView)
  var type = this.options.type
  if (type && data instanceof ArrayBuffer) data = new type(data)
  
  this.stream.queue(data)
}

WebsocketStream.prototype.onError = function(err) {
  this.stream.emit('error', err)
}

WebsocketStream.prototype.onClose = function(err) {
  if (this._destroy) return
  this.stream.emit('end')
  this.stream.emit('close')
}

WebsocketStream.prototype.onOpen = function(err) {
  if (this._destroy) return
  this._open = true
  for (var i = 0; i < this._buffer.length; i++) {
    this._write(this._buffer[i])
  }
  this._buffer = undefined
  this.stream.emit('open')
  this.stream.emit('connect')
  if (this._end) this.ws.close()
}

WebsocketStream.prototype.write = function(data) {
  if (!this._open) {
    this._buffer.push(data)
  } else {
    this._write(data)
  }
}

WebsocketStream.prototype._write = function(data) {
  if (this.ws.readyState == 1)
    // we are connected
    typeof WebSocket != 'undefined' && this.ws instanceof WebSocket
      ? this.ws.send(data)
      : this.ws.send(data, { binary : isBuffer(data) })
  else
    this.stream.emit('error', 'Not connected')
}

WebsocketStream.prototype.end = function(data) {
  if (data !== undefined) this.stream.queue(data)
  if (this._open) this.ws.close()
  this._end = true
}

}).call(this,require('_process'))
},{"_process":122,"isbuffer":26,"through":145,"ws":153}],153:[function(require,module,exports){

/**
 * Module dependencies.
 */

var global = (function() { return this; })();

/**
 * WebSocket constructor.
 */

var WebSocket = global.WebSocket || global.MozWebSocket;

/**
 * Module exports.
 */

module.exports = WebSocket ? ws : null;

/**
 * WebSocket constructor.
 *
 * The third `opts` options object gets ignored in web browsers, since it's
 * non-standard, and throws a TypeError if passed to the constructor.
 * See: https://github.com/einaros/ws/issues/227
 *
 * @param {String} uri
 * @param {Array} protocols (optional)
 * @param {Object) opts (optional)
 * @api public
 */

function ws(uri, protocols, opts) {
  var instance;
  if (protocols) {
    instance = new WebSocket(uri, protocols);
  } else {
    instance = new WebSocket(uri);
  }
  return instance;
}

if (WebSocket) ws.prototype = WebSocket.prototype;

},{}],154:[function(require,module,exports){
'use strict';

module.exports = function() {
  throw new Error(
    'ws does not work in the browser. Browser clients must use the native ' +
      'WebSocket object'
  );
};

},{}],"async":[function(require,module,exports){
(function (process,global,setImmediate){
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
  typeof define === 'function' && define.amd ? define(['exports'], factory) :
  (factory((global.async = global.async || {})));
}(this, (function (exports) { 'use strict';

function slice(arrayLike, start) {
    start = start|0;
    var newLen = Math.max(arrayLike.length - start, 0);
    var newArr = Array(newLen);
    for(var idx = 0; idx < newLen; idx++)  {
        newArr[idx] = arrayLike[start + idx];
    }
    return newArr;
}

/**
 * Creates a continuation function with some arguments already applied.
 *
 * Useful as a shorthand when combined with other control flow functions. Any
 * arguments passed to the returned function are added to the arguments
 * originally passed to apply.
 *
 * @name apply
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {Function} fn - The function you want to eventually apply all
 * arguments to. Invokes with (arguments...).
 * @param {...*} arguments... - Any number of arguments to automatically apply
 * when the continuation is called.
 * @returns {Function} the partially-applied function
 * @example
 *
 * // using apply
 * async.parallel([
 *     async.apply(fs.writeFile, 'testfile1', 'test1'),
 *     async.apply(fs.writeFile, 'testfile2', 'test2')
 * ]);
 *
 *
 * // the same process without using apply
 * async.parallel([
 *     function(callback) {
 *         fs.writeFile('testfile1', 'test1', callback);
 *     },
 *     function(callback) {
 *         fs.writeFile('testfile2', 'test2', callback);
 *     }
 * ]);
 *
 * // It's possible to pass any number of additional arguments when calling the
 * // continuation:
 *
 * node> var fn = async.apply(sys.puts, 'one');
 * node> fn('two', 'three');
 * one
 * two
 * three
 */
var apply = function(fn/*, ...args*/) {
    var args = slice(arguments, 1);
    return function(/*callArgs*/) {
        var callArgs = slice(arguments);
        return fn.apply(null, args.concat(callArgs));
    };
};

var initialParams = function (fn) {
    return function (/*...args, callback*/) {
        var args = slice(arguments);
        var callback = args.pop();
        fn.call(this, args, callback);
    };
};

/**
 * Checks if `value` is the
 * [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
 * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an object, else `false`.
 * @example
 *
 * _.isObject({});
 * // => true
 *
 * _.isObject([1, 2, 3]);
 * // => true
 *
 * _.isObject(_.noop);
 * // => true
 *
 * _.isObject(null);
 * // => false
 */
function isObject(value) {
  var type = typeof value;
  return value != null && (type == 'object' || type == 'function');
}

var hasSetImmediate = typeof setImmediate === 'function' && setImmediate;
var hasNextTick = typeof process === 'object' && typeof process.nextTick === 'function';

function fallback(fn) {
    setTimeout(fn, 0);
}

function wrap(defer) {
    return function (fn/*, ...args*/) {
        var args = slice(arguments, 1);
        defer(function () {
            fn.apply(null, args);
        });
    };
}

var _defer;

if (hasSetImmediate) {
    _defer = setImmediate;
} else if (hasNextTick) {
    _defer = process.nextTick;
} else {
    _defer = fallback;
}

var setImmediate$1 = wrap(_defer);

/**
 * Take a sync function and make it async, passing its return value to a
 * callback. This is useful for plugging sync functions into a waterfall,
 * series, or other async functions. Any arguments passed to the generated
 * function will be passed to the wrapped function (except for the final
 * callback argument). Errors thrown will be passed to the callback.
 *
 * If the function passed to `asyncify` returns a Promise, that promises's
 * resolved/rejected state will be used to call the callback, rather than simply
 * the synchronous return value.
 *
 * This also means you can asyncify ES2017 `async` functions.
 *
 * @name asyncify
 * @static
 * @memberOf module:Utils
 * @method
 * @alias wrapSync
 * @category Util
 * @param {Function} func - The synchronous function, or Promise-returning
 * function to convert to an {@link AsyncFunction}.
 * @returns {AsyncFunction} An asynchronous wrapper of the `func`. To be
 * invoked with `(args..., callback)`.
 * @example
 *
 * // passing a regular synchronous function
 * async.waterfall([
 *     async.apply(fs.readFile, filename, "utf8"),
 *     async.asyncify(JSON.parse),
 *     function (data, next) {
 *         // data is the result of parsing the text.
 *         // If there was a parsing error, it would have been caught.
 *     }
 * ], callback);
 *
 * // passing a function returning a promise
 * async.waterfall([
 *     async.apply(fs.readFile, filename, "utf8"),
 *     async.asyncify(function (contents) {
 *         return db.model.create(contents);
 *     }),
 *     function (model, next) {
 *         // `model` is the instantiated model object.
 *         // If there was an error, this function would be skipped.
 *     }
 * ], callback);
 *
 * // es2017 example, though `asyncify` is not needed if your JS environment
 * // supports async functions out of the box
 * var q = async.queue(async.asyncify(async function(file) {
 *     var intermediateStep = await processFile(file);
 *     return await somePromise(intermediateStep)
 * }));
 *
 * q.push(files);
 */
function asyncify(func) {
    return initialParams(function (args, callback) {
        var result;
        try {
            result = func.apply(this, args);
        } catch (e) {
            return callback(e);
        }
        // if result is Promise object
        if (isObject(result) && typeof result.then === 'function') {
            result.then(function(value) {
                invokeCallback(callback, null, value);
            }, function(err) {
                invokeCallback(callback, err.message ? err : new Error(err));
            });
        } else {
            callback(null, result);
        }
    });
}

function invokeCallback(callback, error, value) {
    try {
        callback(error, value);
    } catch (e) {
        setImmediate$1(rethrow, e);
    }
}

function rethrow(error) {
    throw error;
}

var supportsSymbol = typeof Symbol === 'function';

function isAsync(fn) {
    return supportsSymbol && fn[Symbol.toStringTag] === 'AsyncFunction';
}

function wrapAsync(asyncFn) {
    return isAsync(asyncFn) ? asyncify(asyncFn) : asyncFn;
}

function applyEach$1(eachfn) {
    return function(fns/*, ...args*/) {
        var args = slice(arguments, 1);
        var go = initialParams(function(args, callback) {
            var that = this;
            return eachfn(fns, function (fn, cb) {
                wrapAsync(fn).apply(that, args.concat(cb));
            }, callback);
        });
        if (args.length) {
            return go.apply(this, args);
        }
        else {
            return go;
        }
    };
}

/** Detect free variable `global` from Node.js. */
var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;

/** Detect free variable `self`. */
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

/** Used as a reference to the global object. */
var root = freeGlobal || freeSelf || Function('return this')();

/** Built-in value references. */
var Symbol$1 = root.Symbol;

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var nativeObjectToString = objectProto.toString;

/** Built-in value references. */
var symToStringTag$1 = Symbol$1 ? Symbol$1.toStringTag : undefined;

/**
 * A specialized version of `baseGetTag` which ignores `Symbol.toStringTag` values.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the raw `toStringTag`.
 */
function getRawTag(value) {
  var isOwn = hasOwnProperty.call(value, symToStringTag$1),
      tag = value[symToStringTag$1];

  try {
    value[symToStringTag$1] = undefined;
    var unmasked = true;
  } catch (e) {}

  var result = nativeObjectToString.call(value);
  if (unmasked) {
    if (isOwn) {
      value[symToStringTag$1] = tag;
    } else {
      delete value[symToStringTag$1];
    }
  }
  return result;
}

/** Used for built-in method references. */
var objectProto$1 = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var nativeObjectToString$1 = objectProto$1.toString;

/**
 * Converts `value` to a string using `Object.prototype.toString`.
 *
 * @private
 * @param {*} value The value to convert.
 * @returns {string} Returns the converted string.
 */
function objectToString(value) {
  return nativeObjectToString$1.call(value);
}

/** `Object#toString` result references. */
var nullTag = '[object Null]';
var undefinedTag = '[object Undefined]';

/** Built-in value references. */
var symToStringTag = Symbol$1 ? Symbol$1.toStringTag : undefined;

/**
 * The base implementation of `getTag` without fallbacks for buggy environments.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the `toStringTag`.
 */
function baseGetTag(value) {
  if (value == null) {
    return value === undefined ? undefinedTag : nullTag;
  }
  return (symToStringTag && symToStringTag in Object(value))
    ? getRawTag(value)
    : objectToString(value);
}

/** `Object#toString` result references. */
var asyncTag = '[object AsyncFunction]';
var funcTag = '[object Function]';
var genTag = '[object GeneratorFunction]';
var proxyTag = '[object Proxy]';

/**
 * Checks if `value` is classified as a `Function` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a function, else `false`.
 * @example
 *
 * _.isFunction(_);
 * // => true
 *
 * _.isFunction(/abc/);
 * // => false
 */
function isFunction(value) {
  if (!isObject(value)) {
    return false;
  }
  // The use of `Object#toString` avoids issues with the `typeof` operator
  // in Safari 9 which returns 'object' for typed arrays and other constructors.
  var tag = baseGetTag(value);
  return tag == funcTag || tag == genTag || tag == asyncTag || tag == proxyTag;
}

/** Used as references for various `Number` constants. */
var MAX_SAFE_INTEGER = 9007199254740991;

/**
 * Checks if `value` is a valid array-like length.
 *
 * **Note:** This method is loosely based on
 * [`ToLength`](http://ecma-international.org/ecma-262/7.0/#sec-tolength).
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a valid length, else `false`.
 * @example
 *
 * _.isLength(3);
 * // => true
 *
 * _.isLength(Number.MIN_VALUE);
 * // => false
 *
 * _.isLength(Infinity);
 * // => false
 *
 * _.isLength('3');
 * // => false
 */
function isLength(value) {
  return typeof value == 'number' &&
    value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
}

/**
 * Checks if `value` is array-like. A value is considered array-like if it's
 * not a function and has a `value.length` that's an integer greater than or
 * equal to `0` and less than or equal to `Number.MAX_SAFE_INTEGER`.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is array-like, else `false`.
 * @example
 *
 * _.isArrayLike([1, 2, 3]);
 * // => true
 *
 * _.isArrayLike(document.body.children);
 * // => true
 *
 * _.isArrayLike('abc');
 * // => true
 *
 * _.isArrayLike(_.noop);
 * // => false
 */
function isArrayLike(value) {
  return value != null && isLength(value.length) && !isFunction(value);
}

// A temporary value used to identify if the loop should be broken.
// See #1064, #1293
var breakLoop = {};

/**
 * This method returns `undefined`.
 *
 * @static
 * @memberOf _
 * @since 2.3.0
 * @category Util
 * @example
 *
 * _.times(2, _.noop);
 * // => [undefined, undefined]
 */
function noop() {
  // No operation performed.
}

function once(fn) {
    return function () {
        if (fn === null) return;
        var callFn = fn;
        fn = null;
        callFn.apply(this, arguments);
    };
}

var iteratorSymbol = typeof Symbol === 'function' && Symbol.iterator;

var getIterator = function (coll) {
    return iteratorSymbol && coll[iteratorSymbol] && coll[iteratorSymbol]();
};

/**
 * The base implementation of `_.times` without support for iteratee shorthands
 * or max array length checks.
 *
 * @private
 * @param {number} n The number of times to invoke `iteratee`.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns the array of results.
 */
function baseTimes(n, iteratee) {
  var index = -1,
      result = Array(n);

  while (++index < n) {
    result[index] = iteratee(index);
  }
  return result;
}

/**
 * Checks if `value` is object-like. A value is object-like if it's not `null`
 * and has a `typeof` result of "object".
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is object-like, else `false`.
 * @example
 *
 * _.isObjectLike({});
 * // => true
 *
 * _.isObjectLike([1, 2, 3]);
 * // => true
 *
 * _.isObjectLike(_.noop);
 * // => false
 *
 * _.isObjectLike(null);
 * // => false
 */
function isObjectLike(value) {
  return value != null && typeof value == 'object';
}

/** `Object#toString` result references. */
var argsTag = '[object Arguments]';

/**
 * The base implementation of `_.isArguments`.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an `arguments` object,
 */
function baseIsArguments(value) {
  return isObjectLike(value) && baseGetTag(value) == argsTag;
}

/** Used for built-in method references. */
var objectProto$3 = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty$2 = objectProto$3.hasOwnProperty;

/** Built-in value references. */
var propertyIsEnumerable = objectProto$3.propertyIsEnumerable;

/**
 * Checks if `value` is likely an `arguments` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an `arguments` object,
 *  else `false`.
 * @example
 *
 * _.isArguments(function() { return arguments; }());
 * // => true
 *
 * _.isArguments([1, 2, 3]);
 * // => false
 */
var isArguments = baseIsArguments(function() { return arguments; }()) ? baseIsArguments : function(value) {
  return isObjectLike(value) && hasOwnProperty$2.call(value, 'callee') &&
    !propertyIsEnumerable.call(value, 'callee');
};

/**
 * Checks if `value` is classified as an `Array` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an array, else `false`.
 * @example
 *
 * _.isArray([1, 2, 3]);
 * // => true
 *
 * _.isArray(document.body.children);
 * // => false
 *
 * _.isArray('abc');
 * // => false
 *
 * _.isArray(_.noop);
 * // => false
 */
var isArray = Array.isArray;

/**
 * This method returns `false`.
 *
 * @static
 * @memberOf _
 * @since 4.13.0
 * @category Util
 * @returns {boolean} Returns `false`.
 * @example
 *
 * _.times(2, _.stubFalse);
 * // => [false, false]
 */
function stubFalse() {
  return false;
}

/** Detect free variable `exports`. */
var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;

/** Detect free variable `module`. */
var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;

/** Detect the popular CommonJS extension `module.exports`. */
var moduleExports = freeModule && freeModule.exports === freeExports;

/** Built-in value references. */
var Buffer = moduleExports ? root.Buffer : undefined;

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeIsBuffer = Buffer ? Buffer.isBuffer : undefined;

/**
 * Checks if `value` is a buffer.
 *
 * @static
 * @memberOf _
 * @since 4.3.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a buffer, else `false`.
 * @example
 *
 * _.isBuffer(new Buffer(2));
 * // => true
 *
 * _.isBuffer(new Uint8Array(2));
 * // => false
 */
var isBuffer = nativeIsBuffer || stubFalse;

/** Used as references for various `Number` constants. */
var MAX_SAFE_INTEGER$1 = 9007199254740991;

/** Used to detect unsigned integer values. */
var reIsUint = /^(?:0|[1-9]\d*)$/;

/**
 * Checks if `value` is a valid array-like index.
 *
 * @private
 * @param {*} value The value to check.
 * @param {number} [length=MAX_SAFE_INTEGER] The upper bounds of a valid index.
 * @returns {boolean} Returns `true` if `value` is a valid index, else `false`.
 */
function isIndex(value, length) {
  var type = typeof value;
  length = length == null ? MAX_SAFE_INTEGER$1 : length;

  return !!length &&
    (type == 'number' ||
      (type != 'symbol' && reIsUint.test(value))) &&
        (value > -1 && value % 1 == 0 && value < length);
}

/** `Object#toString` result references. */
var argsTag$1 = '[object Arguments]';
var arrayTag = '[object Array]';
var boolTag = '[object Boolean]';
var dateTag = '[object Date]';
var errorTag = '[object Error]';
var funcTag$1 = '[object Function]';
var mapTag = '[object Map]';
var numberTag = '[object Number]';
var objectTag = '[object Object]';
var regexpTag = '[object RegExp]';
var setTag = '[object Set]';
var stringTag = '[object String]';
var weakMapTag = '[object WeakMap]';

var arrayBufferTag = '[object ArrayBuffer]';
var dataViewTag = '[object DataView]';
var float32Tag = '[object Float32Array]';
var float64Tag = '[object Float64Array]';
var int8Tag = '[object Int8Array]';
var int16Tag = '[object Int16Array]';
var int32Tag = '[object Int32Array]';
var uint8Tag = '[object Uint8Array]';
var uint8ClampedTag = '[object Uint8ClampedArray]';
var uint16Tag = '[object Uint16Array]';
var uint32Tag = '[object Uint32Array]';

/** Used to identify `toStringTag` values of typed arrays. */
var typedArrayTags = {};
typedArrayTags[float32Tag] = typedArrayTags[float64Tag] =
typedArrayTags[int8Tag] = typedArrayTags[int16Tag] =
typedArrayTags[int32Tag] = typedArrayTags[uint8Tag] =
typedArrayTags[uint8ClampedTag] = typedArrayTags[uint16Tag] =
typedArrayTags[uint32Tag] = true;
typedArrayTags[argsTag$1] = typedArrayTags[arrayTag] =
typedArrayTags[arrayBufferTag] = typedArrayTags[boolTag] =
typedArrayTags[dataViewTag] = typedArrayTags[dateTag] =
typedArrayTags[errorTag] = typedArrayTags[funcTag$1] =
typedArrayTags[mapTag] = typedArrayTags[numberTag] =
typedArrayTags[objectTag] = typedArrayTags[regexpTag] =
typedArrayTags[setTag] = typedArrayTags[stringTag] =
typedArrayTags[weakMapTag] = false;

/**
 * The base implementation of `_.isTypedArray` without Node.js optimizations.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a typed array, else `false`.
 */
function baseIsTypedArray(value) {
  return isObjectLike(value) &&
    isLength(value.length) && !!typedArrayTags[baseGetTag(value)];
}

/**
 * The base implementation of `_.unary` without support for storing metadata.
 *
 * @private
 * @param {Function} func The function to cap arguments for.
 * @returns {Function} Returns the new capped function.
 */
function baseUnary(func) {
  return function(value) {
    return func(value);
  };
}

/** Detect free variable `exports`. */
var freeExports$1 = typeof exports == 'object' && exports && !exports.nodeType && exports;

/** Detect free variable `module`. */
var freeModule$1 = freeExports$1 && typeof module == 'object' && module && !module.nodeType && module;

/** Detect the popular CommonJS extension `module.exports`. */
var moduleExports$1 = freeModule$1 && freeModule$1.exports === freeExports$1;

/** Detect free variable `process` from Node.js. */
var freeProcess = moduleExports$1 && freeGlobal.process;

/** Used to access faster Node.js helpers. */
var nodeUtil = (function() {
  try {
    // Use `util.types` for Node.js 10+.
    var types = freeModule$1 && freeModule$1.require && freeModule$1.require('util').types;

    if (types) {
      return types;
    }

    // Legacy `process.binding('util')` for Node.js < 10.
    return freeProcess && freeProcess.binding && freeProcess.binding('util');
  } catch (e) {}
}());

/* Node.js helper references. */
var nodeIsTypedArray = nodeUtil && nodeUtil.isTypedArray;

/**
 * Checks if `value` is classified as a typed array.
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a typed array, else `false`.
 * @example
 *
 * _.isTypedArray(new Uint8Array);
 * // => true
 *
 * _.isTypedArray([]);
 * // => false
 */
var isTypedArray = nodeIsTypedArray ? baseUnary(nodeIsTypedArray) : baseIsTypedArray;

/** Used for built-in method references. */
var objectProto$2 = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty$1 = objectProto$2.hasOwnProperty;

/**
 * Creates an array of the enumerable property names of the array-like `value`.
 *
 * @private
 * @param {*} value The value to query.
 * @param {boolean} inherited Specify returning inherited property names.
 * @returns {Array} Returns the array of property names.
 */
function arrayLikeKeys(value, inherited) {
  var isArr = isArray(value),
      isArg = !isArr && isArguments(value),
      isBuff = !isArr && !isArg && isBuffer(value),
      isType = !isArr && !isArg && !isBuff && isTypedArray(value),
      skipIndexes = isArr || isArg || isBuff || isType,
      result = skipIndexes ? baseTimes(value.length, String) : [],
      length = result.length;

  for (var key in value) {
    if ((inherited || hasOwnProperty$1.call(value, key)) &&
        !(skipIndexes && (
           // Safari 9 has enumerable `arguments.length` in strict mode.
           key == 'length' ||
           // Node.js 0.10 has enumerable non-index properties on buffers.
           (isBuff && (key == 'offset' || key == 'parent')) ||
           // PhantomJS 2 has enumerable non-index properties on typed arrays.
           (isType && (key == 'buffer' || key == 'byteLength' || key == 'byteOffset')) ||
           // Skip index properties.
           isIndex(key, length)
        ))) {
      result.push(key);
    }
  }
  return result;
}

/** Used for built-in method references. */
var objectProto$5 = Object.prototype;

/**
 * Checks if `value` is likely a prototype object.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a prototype, else `false`.
 */
function isPrototype(value) {
  var Ctor = value && value.constructor,
      proto = (typeof Ctor == 'function' && Ctor.prototype) || objectProto$5;

  return value === proto;
}

/**
 * Creates a unary function that invokes `func` with its argument transformed.
 *
 * @private
 * @param {Function} func The function to wrap.
 * @param {Function} transform The argument transform.
 * @returns {Function} Returns the new function.
 */
function overArg(func, transform) {
  return function(arg) {
    return func(transform(arg));
  };
}

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeKeys = overArg(Object.keys, Object);

/** Used for built-in method references. */
var objectProto$4 = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty$3 = objectProto$4.hasOwnProperty;

/**
 * The base implementation of `_.keys` which doesn't treat sparse arrays as dense.
 *
 * @private
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names.
 */
function baseKeys(object) {
  if (!isPrototype(object)) {
    return nativeKeys(object);
  }
  var result = [];
  for (var key in Object(object)) {
    if (hasOwnProperty$3.call(object, key) && key != 'constructor') {
      result.push(key);
    }
  }
  return result;
}

/**
 * Creates an array of the own enumerable property names of `object`.
 *
 * **Note:** Non-object values are coerced to objects. See the
 * [ES spec](http://ecma-international.org/ecma-262/7.0/#sec-object.keys)
 * for more details.
 *
 * @static
 * @since 0.1.0
 * @memberOf _
 * @category Object
 * @param {Object} object The object to query.
 * @returns {Array} Returns the array of property names.
 * @example
 *
 * function Foo() {
 *   this.a = 1;
 *   this.b = 2;
 * }
 *
 * Foo.prototype.c = 3;
 *
 * _.keys(new Foo);
 * // => ['a', 'b'] (iteration order is not guaranteed)
 *
 * _.keys('hi');
 * // => ['0', '1']
 */
function keys(object) {
  return isArrayLike(object) ? arrayLikeKeys(object) : baseKeys(object);
}

function createArrayIterator(coll) {
    var i = -1;
    var len = coll.length;
    return function next() {
        return ++i < len ? {value: coll[i], key: i} : null;
    }
}

function createES2015Iterator(iterator) {
    var i = -1;
    return function next() {
        var item = iterator.next();
        if (item.done)
            return null;
        i++;
        return {value: item.value, key: i};
    }
}

function createObjectIterator(obj) {
    var okeys = keys(obj);
    var i = -1;
    var len = okeys.length;
    return function next() {
        var key = okeys[++i];
        return i < len ? {value: obj[key], key: key} : null;
    };
}

function iterator(coll) {
    if (isArrayLike(coll)) {
        return createArrayIterator(coll);
    }

    var iterator = getIterator(coll);
    return iterator ? createES2015Iterator(iterator) : createObjectIterator(coll);
}

function onlyOnce(fn) {
    return function() {
        if (fn === null) throw new Error("Callback was already called.");
        var callFn = fn;
        fn = null;
        callFn.apply(this, arguments);
    };
}

function _eachOfLimit(limit) {
    return function (obj, iteratee, callback) {
        callback = once(callback || noop);
        if (limit <= 0 || !obj) {
            return callback(null);
        }
        var nextElem = iterator(obj);
        var done = false;
        var running = 0;
        var looping = false;

        function iterateeCallback(err, value) {
            running -= 1;
            if (err) {
                done = true;
                callback(err);
            }
            else if (value === breakLoop || (done && running <= 0)) {
                done = true;
                return callback(null);
            }
            else if (!looping) {
                replenish();
            }
        }

        function replenish () {
            looping = true;
            while (running < limit && !done) {
                var elem = nextElem();
                if (elem === null) {
                    done = true;
                    if (running <= 0) {
                        callback(null);
                    }
                    return;
                }
                running += 1;
                iteratee(elem.value, elem.key, onlyOnce(iterateeCallback));
            }
            looping = false;
        }

        replenish();
    };
}

/**
 * The same as [`eachOf`]{@link module:Collections.eachOf} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name eachOfLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.eachOf]{@link module:Collections.eachOf}
 * @alias forEachOfLimit
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async function to apply to each
 * item in `coll`. The `key` is the item's key, or index in the case of an
 * array.
 * Invoked with (item, key, callback).
 * @param {Function} [callback] - A callback which is called when all
 * `iteratee` functions have finished, or an error occurs. Invoked with (err).
 */
function eachOfLimit(coll, limit, iteratee, callback) {
    _eachOfLimit(limit)(coll, wrapAsync(iteratee), callback);
}

function doLimit(fn, limit) {
    return function (iterable, iteratee, callback) {
        return fn(iterable, limit, iteratee, callback);
    };
}

// eachOf implementation optimized for array-likes
function eachOfArrayLike(coll, iteratee, callback) {
    callback = once(callback || noop);
    var index = 0,
        completed = 0,
        length = coll.length;
    if (length === 0) {
        callback(null);
    }

    function iteratorCallback(err, value) {
        if (err) {
            callback(err);
        } else if ((++completed === length) || value === breakLoop) {
            callback(null);
        }
    }

    for (; index < length; index++) {
        iteratee(coll[index], index, onlyOnce(iteratorCallback));
    }
}

// a generic version of eachOf which can handle array, object, and iterator cases.
var eachOfGeneric = doLimit(eachOfLimit, Infinity);

/**
 * Like [`each`]{@link module:Collections.each}, except that it passes the key (or index) as the second argument
 * to the iteratee.
 *
 * @name eachOf
 * @static
 * @memberOf module:Collections
 * @method
 * @alias forEachOf
 * @category Collection
 * @see [async.each]{@link module:Collections.each}
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A function to apply to each
 * item in `coll`.
 * The `key` is the item's key, or index in the case of an array.
 * Invoked with (item, key, callback).
 * @param {Function} [callback] - A callback which is called when all
 * `iteratee` functions have finished, or an error occurs. Invoked with (err).
 * @example
 *
 * var obj = {dev: "/dev.json", test: "/test.json", prod: "/prod.json"};
 * var configs = {};
 *
 * async.forEachOf(obj, function (value, key, callback) {
 *     fs.readFile(__dirname + value, "utf8", function (err, data) {
 *         if (err) return callback(err);
 *         try {
 *             configs[key] = JSON.parse(data);
 *         } catch (e) {
 *             return callback(e);
 *         }
 *         callback();
 *     });
 * }, function (err) {
 *     if (err) console.error(err.message);
 *     // configs is now a map of JSON data
 *     doSomethingWith(configs);
 * });
 */
var eachOf = function(coll, iteratee, callback) {
    var eachOfImplementation = isArrayLike(coll) ? eachOfArrayLike : eachOfGeneric;
    eachOfImplementation(coll, wrapAsync(iteratee), callback);
};

function doParallel(fn) {
    return function (obj, iteratee, callback) {
        return fn(eachOf, obj, wrapAsync(iteratee), callback);
    };
}

function _asyncMap(eachfn, arr, iteratee, callback) {
    callback = callback || noop;
    arr = arr || [];
    var results = [];
    var counter = 0;
    var _iteratee = wrapAsync(iteratee);

    eachfn(arr, function (value, _, callback) {
        var index = counter++;
        _iteratee(value, function (err, v) {
            results[index] = v;
            callback(err);
        });
    }, function (err) {
        callback(err, results);
    });
}

/**
 * Produces a new collection of values by mapping each value in `coll` through
 * the `iteratee` function. The `iteratee` is called with an item from `coll`
 * and a callback for when it has finished processing. Each of these callback
 * takes 2 arguments: an `error`, and the transformed item from `coll`. If
 * `iteratee` passes an error to its callback, the main `callback` (for the
 * `map` function) is immediately called with the error.
 *
 * Note, that since this function applies the `iteratee` to each item in
 * parallel, there is no guarantee that the `iteratee` functions will complete
 * in order. However, the results array will be in the same order as the
 * original `coll`.
 *
 * If `map` is passed an Object, the results will be an Array.  The results
 * will roughly be in the order of the original Objects' keys (but this can
 * vary across JavaScript engines).
 *
 * @name map
 * @static
 * @memberOf module:Collections
 * @method
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with the transformed item.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Results is an Array of the
 * transformed items from the `coll`. Invoked with (err, results).
 * @example
 *
 * async.map(['file1','file2','file3'], fs.stat, function(err, results) {
 *     // results is now an array of stats for each file
 * });
 */
var map = doParallel(_asyncMap);

/**
 * Applies the provided arguments to each function in the array, calling
 * `callback` after all functions have completed. If you only provide the first
 * argument, `fns`, then it will return a function which lets you pass in the
 * arguments as if it were a single function call. If more arguments are
 * provided, `callback` is required while `args` is still optional.
 *
 * @name applyEach
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Array|Iterable|Object} fns - A collection of {@link AsyncFunction}s
 * to all call with the same arguments
 * @param {...*} [args] - any number of separate arguments to pass to the
 * function.
 * @param {Function} [callback] - the final argument should be the callback,
 * called when all functions have completed processing.
 * @returns {Function} - If only the first argument, `fns`, is provided, it will
 * return a function which lets you pass in the arguments as if it were a single
 * function call. The signature is `(..args, callback)`. If invoked with any
 * arguments, `callback` is required.
 * @example
 *
 * async.applyEach([enableSearch, updateSchema], 'bucket', callback);
 *
 * // partial application example:
 * async.each(
 *     buckets,
 *     async.applyEach([enableSearch, updateSchema]),
 *     callback
 * );
 */
var applyEach = applyEach$1(map);

function doParallelLimit(fn) {
    return function (obj, limit, iteratee, callback) {
        return fn(_eachOfLimit(limit), obj, wrapAsync(iteratee), callback);
    };
}

/**
 * The same as [`map`]{@link module:Collections.map} but runs a maximum of `limit` async operations at a time.
 *
 * @name mapLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.map]{@link module:Collections.map}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with the transformed item.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Results is an array of the
 * transformed items from the `coll`. Invoked with (err, results).
 */
var mapLimit = doParallelLimit(_asyncMap);

/**
 * The same as [`map`]{@link module:Collections.map} but runs only a single async operation at a time.
 *
 * @name mapSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.map]{@link module:Collections.map}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with the transformed item.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Results is an array of the
 * transformed items from the `coll`. Invoked with (err, results).
 */
var mapSeries = doLimit(mapLimit, 1);

/**
 * The same as [`applyEach`]{@link module:ControlFlow.applyEach} but runs only a single async operation at a time.
 *
 * @name applyEachSeries
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.applyEach]{@link module:ControlFlow.applyEach}
 * @category Control Flow
 * @param {Array|Iterable|Object} fns - A collection of {@link AsyncFunction}s to all
 * call with the same arguments
 * @param {...*} [args] - any number of separate arguments to pass to the
 * function.
 * @param {Function} [callback] - the final argument should be the callback,
 * called when all functions have completed processing.
 * @returns {Function} - If only the first argument is provided, it will return
 * a function which lets you pass in the arguments as if it were a single
 * function call.
 */
var applyEachSeries = applyEach$1(mapSeries);

/**
 * A specialized version of `_.forEach` for arrays without support for
 * iteratee shorthands.
 *
 * @private
 * @param {Array} [array] The array to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns `array`.
 */
function arrayEach(array, iteratee) {
  var index = -1,
      length = array == null ? 0 : array.length;

  while (++index < length) {
    if (iteratee(array[index], index, array) === false) {
      break;
    }
  }
  return array;
}

/**
 * Creates a base function for methods like `_.forIn` and `_.forOwn`.
 *
 * @private
 * @param {boolean} [fromRight] Specify iterating from right to left.
 * @returns {Function} Returns the new base function.
 */
function createBaseFor(fromRight) {
  return function(object, iteratee, keysFunc) {
    var index = -1,
        iterable = Object(object),
        props = keysFunc(object),
        length = props.length;

    while (length--) {
      var key = props[fromRight ? length : ++index];
      if (iteratee(iterable[key], key, iterable) === false) {
        break;
      }
    }
    return object;
  };
}

/**
 * The base implementation of `baseForOwn` which iterates over `object`
 * properties returned by `keysFunc` and invokes `iteratee` for each property.
 * Iteratee functions may exit iteration early by explicitly returning `false`.
 *
 * @private
 * @param {Object} object The object to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @param {Function} keysFunc The function to get the keys of `object`.
 * @returns {Object} Returns `object`.
 */
var baseFor = createBaseFor();

/**
 * The base implementation of `_.forOwn` without support for iteratee shorthands.
 *
 * @private
 * @param {Object} object The object to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Object} Returns `object`.
 */
function baseForOwn(object, iteratee) {
  return object && baseFor(object, iteratee, keys);
}

/**
 * The base implementation of `_.findIndex` and `_.findLastIndex` without
 * support for iteratee shorthands.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {Function} predicate The function invoked per iteration.
 * @param {number} fromIndex The index to search from.
 * @param {boolean} [fromRight] Specify iterating from right to left.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function baseFindIndex(array, predicate, fromIndex, fromRight) {
  var length = array.length,
      index = fromIndex + (fromRight ? 1 : -1);

  while ((fromRight ? index-- : ++index < length)) {
    if (predicate(array[index], index, array)) {
      return index;
    }
  }
  return -1;
}

/**
 * The base implementation of `_.isNaN` without support for number objects.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is `NaN`, else `false`.
 */
function baseIsNaN(value) {
  return value !== value;
}

/**
 * A specialized version of `_.indexOf` which performs strict equality
 * comparisons of values, i.e. `===`.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} value The value to search for.
 * @param {number} fromIndex The index to search from.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function strictIndexOf(array, value, fromIndex) {
  var index = fromIndex - 1,
      length = array.length;

  while (++index < length) {
    if (array[index] === value) {
      return index;
    }
  }
  return -1;
}

/**
 * The base implementation of `_.indexOf` without `fromIndex` bounds checks.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} value The value to search for.
 * @param {number} fromIndex The index to search from.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function baseIndexOf(array, value, fromIndex) {
  return value === value
    ? strictIndexOf(array, value, fromIndex)
    : baseFindIndex(array, baseIsNaN, fromIndex);
}

/**
 * Determines the best order for running the {@link AsyncFunction}s in `tasks`, based on
 * their requirements. Each function can optionally depend on other functions
 * being completed first, and each function is run as soon as its requirements
 * are satisfied.
 *
 * If any of the {@link AsyncFunction}s pass an error to their callback, the `auto` sequence
 * will stop. Further tasks will not execute (so any other functions depending
 * on it will not run), and the main `callback` is immediately called with the
 * error.
 *
 * {@link AsyncFunction}s also receive an object containing the results of functions which
 * have completed so far as the first argument, if they have dependencies. If a
 * task function has no dependencies, it will only be passed a callback.
 *
 * @name auto
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Object} tasks - An object. Each of its properties is either a
 * function or an array of requirements, with the {@link AsyncFunction} itself the last item
 * in the array. The object's key of a property serves as the name of the task
 * defined by that property, i.e. can be used when specifying requirements for
 * other tasks. The function receives one or two arguments:
 * * a `results` object, containing the results of the previously executed
 *   functions, only passed if the task has any dependencies,
 * * a `callback(err, result)` function, which must be called when finished,
 *   passing an `error` (which can be `null`) and the result of the function's
 *   execution.
 * @param {number} [concurrency=Infinity] - An optional `integer` for
 * determining the maximum number of tasks that can be run in parallel. By
 * default, as many as possible.
 * @param {Function} [callback] - An optional callback which is called when all
 * the tasks have been completed. It receives the `err` argument if any `tasks`
 * pass an error to their callback. Results are always returned; however, if an
 * error occurs, no further `tasks` will be performed, and the results object
 * will only contain partial results. Invoked with (err, results).
 * @returns undefined
 * @example
 *
 * async.auto({
 *     // this function will just be passed a callback
 *     readData: async.apply(fs.readFile, 'data.txt', 'utf-8'),
 *     showData: ['readData', function(results, cb) {
 *         // results.readData is the file's contents
 *         // ...
 *     }]
 * }, callback);
 *
 * async.auto({
 *     get_data: function(callback) {
 *         console.log('in get_data');
 *         // async code to get some data
 *         callback(null, 'data', 'converted to array');
 *     },
 *     make_folder: function(callback) {
 *         console.log('in make_folder');
 *         // async code to create a directory to store a file in
 *         // this is run at the same time as getting the data
 *         callback(null, 'folder');
 *     },
 *     write_file: ['get_data', 'make_folder', function(results, callback) {
 *         console.log('in write_file', JSON.stringify(results));
 *         // once there is some data and the directory exists,
 *         // write the data to a file in the directory
 *         callback(null, 'filename');
 *     }],
 *     email_link: ['write_file', function(results, callback) {
 *         console.log('in email_link', JSON.stringify(results));
 *         // once the file is written let's email a link to it...
 *         // results.write_file contains the filename returned by write_file.
 *         callback(null, {'file':results.write_file, 'email':'user@example.com'});
 *     }]
 * }, function(err, results) {
 *     console.log('err = ', err);
 *     console.log('results = ', results);
 * });
 */
var auto = function (tasks, concurrency, callback) {
    if (typeof concurrency === 'function') {
        // concurrency is optional, shift the args.
        callback = concurrency;
        concurrency = null;
    }
    callback = once(callback || noop);
    var keys$$1 = keys(tasks);
    var numTasks = keys$$1.length;
    if (!numTasks) {
        return callback(null);
    }
    if (!concurrency) {
        concurrency = numTasks;
    }

    var results = {};
    var runningTasks = 0;
    var hasError = false;

    var listeners = Object.create(null);

    var readyTasks = [];

    // for cycle detection:
    var readyToCheck = []; // tasks that have been identified as reachable
    // without the possibility of returning to an ancestor task
    var uncheckedDependencies = {};

    baseForOwn(tasks, function (task, key) {
        if (!isArray(task)) {
            // no dependencies
            enqueueTask(key, [task]);
            readyToCheck.push(key);
            return;
        }

        var dependencies = task.slice(0, task.length - 1);
        var remainingDependencies = dependencies.length;
        if (remainingDependencies === 0) {
            enqueueTask(key, task);
            readyToCheck.push(key);
            return;
        }
        uncheckedDependencies[key] = remainingDependencies;

        arrayEach(dependencies, function (dependencyName) {
            if (!tasks[dependencyName]) {
                throw new Error('async.auto task `' + key +
                    '` has a non-existent dependency `' +
                    dependencyName + '` in ' +
                    dependencies.join(', '));
            }
            addListener(dependencyName, function () {
                remainingDependencies--;
                if (remainingDependencies === 0) {
                    enqueueTask(key, task);
                }
            });
        });
    });

    checkForDeadlocks();
    processQueue();

    function enqueueTask(key, task) {
        readyTasks.push(function () {
            runTask(key, task);
        });
    }

    function processQueue() {
        if (readyTasks.length === 0 && runningTasks === 0) {
            return callback(null, results);
        }
        while(readyTasks.length && runningTasks < concurrency) {
            var run = readyTasks.shift();
            run();
        }

    }

    function addListener(taskName, fn) {
        var taskListeners = listeners[taskName];
        if (!taskListeners) {
            taskListeners = listeners[taskName] = [];
        }

        taskListeners.push(fn);
    }

    function taskComplete(taskName) {
        var taskListeners = listeners[taskName] || [];
        arrayEach(taskListeners, function (fn) {
            fn();
        });
        processQueue();
    }


    function runTask(key, task) {
        if (hasError) return;

        var taskCallback = onlyOnce(function(err, result) {
            runningTasks--;
            if (arguments.length > 2) {
                result = slice(arguments, 1);
            }
            if (err) {
                var safeResults = {};
                baseForOwn(results, function(val, rkey) {
                    safeResults[rkey] = val;
                });
                safeResults[key] = result;
                hasError = true;
                listeners = Object.create(null);

                callback(err, safeResults);
            } else {
                results[key] = result;
                taskComplete(key);
            }
        });

        runningTasks++;
        var taskFn = wrapAsync(task[task.length - 1]);
        if (task.length > 1) {
            taskFn(results, taskCallback);
        } else {
            taskFn(taskCallback);
        }
    }

    function checkForDeadlocks() {
        // Kahn's algorithm
        // https://en.wikipedia.org/wiki/Topological_sorting#Kahn.27s_algorithm
        // http://connalle.blogspot.com/2013/10/topological-sortingkahn-algorithm.html
        var currentTask;
        var counter = 0;
        while (readyToCheck.length) {
            currentTask = readyToCheck.pop();
            counter++;
            arrayEach(getDependents(currentTask), function (dependent) {
                if (--uncheckedDependencies[dependent] === 0) {
                    readyToCheck.push(dependent);
                }
            });
        }

        if (counter !== numTasks) {
            throw new Error(
                'async.auto cannot execute tasks due to a recursive dependency'
            );
        }
    }

    function getDependents(taskName) {
        var result = [];
        baseForOwn(tasks, function (task, key) {
            if (isArray(task) && baseIndexOf(task, taskName, 0) >= 0) {
                result.push(key);
            }
        });
        return result;
    }
};

/**
 * A specialized version of `_.map` for arrays without support for iteratee
 * shorthands.
 *
 * @private
 * @param {Array} [array] The array to iterate over.
 * @param {Function} iteratee The function invoked per iteration.
 * @returns {Array} Returns the new mapped array.
 */
function arrayMap(array, iteratee) {
  var index = -1,
      length = array == null ? 0 : array.length,
      result = Array(length);

  while (++index < length) {
    result[index] = iteratee(array[index], index, array);
  }
  return result;
}

/** `Object#toString` result references. */
var symbolTag = '[object Symbol]';

/**
 * Checks if `value` is classified as a `Symbol` primitive or object.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
 * @example
 *
 * _.isSymbol(Symbol.iterator);
 * // => true
 *
 * _.isSymbol('abc');
 * // => false
 */
function isSymbol(value) {
  return typeof value == 'symbol' ||
    (isObjectLike(value) && baseGetTag(value) == symbolTag);
}

/** Used as references for various `Number` constants. */
var INFINITY = 1 / 0;

/** Used to convert symbols to primitives and strings. */
var symbolProto = Symbol$1 ? Symbol$1.prototype : undefined;
var symbolToString = symbolProto ? symbolProto.toString : undefined;

/**
 * The base implementation of `_.toString` which doesn't convert nullish
 * values to empty strings.
 *
 * @private
 * @param {*} value The value to process.
 * @returns {string} Returns the string.
 */
function baseToString(value) {
  // Exit early for strings to avoid a performance hit in some environments.
  if (typeof value == 'string') {
    return value;
  }
  if (isArray(value)) {
    // Recursively convert values (susceptible to call stack limits).
    return arrayMap(value, baseToString) + '';
  }
  if (isSymbol(value)) {
    return symbolToString ? symbolToString.call(value) : '';
  }
  var result = (value + '');
  return (result == '0' && (1 / value) == -INFINITY) ? '-0' : result;
}

/**
 * The base implementation of `_.slice` without an iteratee call guard.
 *
 * @private
 * @param {Array} array The array to slice.
 * @param {number} [start=0] The start position.
 * @param {number} [end=array.length] The end position.
 * @returns {Array} Returns the slice of `array`.
 */
function baseSlice(array, start, end) {
  var index = -1,
      length = array.length;

  if (start < 0) {
    start = -start > length ? 0 : (length + start);
  }
  end = end > length ? length : end;
  if (end < 0) {
    end += length;
  }
  length = start > end ? 0 : ((end - start) >>> 0);
  start >>>= 0;

  var result = Array(length);
  while (++index < length) {
    result[index] = array[index + start];
  }
  return result;
}

/**
 * Casts `array` to a slice if it's needed.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {number} start The start position.
 * @param {number} [end=array.length] The end position.
 * @returns {Array} Returns the cast slice.
 */
function castSlice(array, start, end) {
  var length = array.length;
  end = end === undefined ? length : end;
  return (!start && end >= length) ? array : baseSlice(array, start, end);
}

/**
 * Used by `_.trim` and `_.trimEnd` to get the index of the last string symbol
 * that is not found in the character symbols.
 *
 * @private
 * @param {Array} strSymbols The string symbols to inspect.
 * @param {Array} chrSymbols The character symbols to find.
 * @returns {number} Returns the index of the last unmatched string symbol.
 */
function charsEndIndex(strSymbols, chrSymbols) {
  var index = strSymbols.length;

  while (index-- && baseIndexOf(chrSymbols, strSymbols[index], 0) > -1) {}
  return index;
}

/**
 * Used by `_.trim` and `_.trimStart` to get the index of the first string symbol
 * that is not found in the character symbols.
 *
 * @private
 * @param {Array} strSymbols The string symbols to inspect.
 * @param {Array} chrSymbols The character symbols to find.
 * @returns {number} Returns the index of the first unmatched string symbol.
 */
function charsStartIndex(strSymbols, chrSymbols) {
  var index = -1,
      length = strSymbols.length;

  while (++index < length && baseIndexOf(chrSymbols, strSymbols[index], 0) > -1) {}
  return index;
}

/**
 * Converts an ASCII `string` to an array.
 *
 * @private
 * @param {string} string The string to convert.
 * @returns {Array} Returns the converted array.
 */
function asciiToArray(string) {
  return string.split('');
}

/** Used to compose unicode character classes. */
var rsAstralRange = '\\ud800-\\udfff';
var rsComboMarksRange = '\\u0300-\\u036f';
var reComboHalfMarksRange = '\\ufe20-\\ufe2f';
var rsComboSymbolsRange = '\\u20d0-\\u20ff';
var rsComboRange = rsComboMarksRange + reComboHalfMarksRange + rsComboSymbolsRange;
var rsVarRange = '\\ufe0e\\ufe0f';

/** Used to compose unicode capture groups. */
var rsZWJ = '\\u200d';

/** Used to detect strings with [zero-width joiners or code points from the astral planes](http://eev.ee/blog/2015/09/12/dark-corners-of-unicode/). */
var reHasUnicode = RegExp('[' + rsZWJ + rsAstralRange  + rsComboRange + rsVarRange + ']');

/**
 * Checks if `string` contains Unicode symbols.
 *
 * @private
 * @param {string} string The string to inspect.
 * @returns {boolean} Returns `true` if a symbol is found, else `false`.
 */
function hasUnicode(string) {
  return reHasUnicode.test(string);
}

/** Used to compose unicode character classes. */
var rsAstralRange$1 = '\\ud800-\\udfff';
var rsComboMarksRange$1 = '\\u0300-\\u036f';
var reComboHalfMarksRange$1 = '\\ufe20-\\ufe2f';
var rsComboSymbolsRange$1 = '\\u20d0-\\u20ff';
var rsComboRange$1 = rsComboMarksRange$1 + reComboHalfMarksRange$1 + rsComboSymbolsRange$1;
var rsVarRange$1 = '\\ufe0e\\ufe0f';

/** Used to compose unicode capture groups. */
var rsAstral = '[' + rsAstralRange$1 + ']';
var rsCombo = '[' + rsComboRange$1 + ']';
var rsFitz = '\\ud83c[\\udffb-\\udfff]';
var rsModifier = '(?:' + rsCombo + '|' + rsFitz + ')';
var rsNonAstral = '[^' + rsAstralRange$1 + ']';
var rsRegional = '(?:\\ud83c[\\udde6-\\uddff]){2}';
var rsSurrPair = '[\\ud800-\\udbff][\\udc00-\\udfff]';
var rsZWJ$1 = '\\u200d';

/** Used to compose unicode regexes. */
var reOptMod = rsModifier + '?';
var rsOptVar = '[' + rsVarRange$1 + ']?';
var rsOptJoin = '(?:' + rsZWJ$1 + '(?:' + [rsNonAstral, rsRegional, rsSurrPair].join('|') + ')' + rsOptVar + reOptMod + ')*';
var rsSeq = rsOptVar + reOptMod + rsOptJoin;
var rsSymbol = '(?:' + [rsNonAstral + rsCombo + '?', rsCombo, rsRegional, rsSurrPair, rsAstral].join('|') + ')';

/** Used to match [string symbols](https://mathiasbynens.be/notes/javascript-unicode). */
var reUnicode = RegExp(rsFitz + '(?=' + rsFitz + ')|' + rsSymbol + rsSeq, 'g');

/**
 * Converts a Unicode `string` to an array.
 *
 * @private
 * @param {string} string The string to convert.
 * @returns {Array} Returns the converted array.
 */
function unicodeToArray(string) {
  return string.match(reUnicode) || [];
}

/**
 * Converts `string` to an array.
 *
 * @private
 * @param {string} string The string to convert.
 * @returns {Array} Returns the converted array.
 */
function stringToArray(string) {
  return hasUnicode(string)
    ? unicodeToArray(string)
    : asciiToArray(string);
}

/**
 * Converts `value` to a string. An empty string is returned for `null`
 * and `undefined` values. The sign of `-0` is preserved.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to convert.
 * @returns {string} Returns the converted string.
 * @example
 *
 * _.toString(null);
 * // => ''
 *
 * _.toString(-0);
 * // => '-0'
 *
 * _.toString([1, 2, 3]);
 * // => '1,2,3'
 */
function toString(value) {
  return value == null ? '' : baseToString(value);
}

/** Used to match leading and trailing whitespace. */
var reTrim = /^\s+|\s+$/g;

/**
 * Removes leading and trailing whitespace or specified characters from `string`.
 *
 * @static
 * @memberOf _
 * @since 3.0.0
 * @category String
 * @param {string} [string=''] The string to trim.
 * @param {string} [chars=whitespace] The characters to trim.
 * @param- {Object} [guard] Enables use as an iteratee for methods like `_.map`.
 * @returns {string} Returns the trimmed string.
 * @example
 *
 * _.trim('  abc  ');
 * // => 'abc'
 *
 * _.trim('-_-abc-_-', '_-');
 * // => 'abc'
 *
 * _.map(['  foo  ', '  bar  '], _.trim);
 * // => ['foo', 'bar']
 */
function trim(string, chars, guard) {
  string = toString(string);
  if (string && (guard || chars === undefined)) {
    return string.replace(reTrim, '');
  }
  if (!string || !(chars = baseToString(chars))) {
    return string;
  }
  var strSymbols = stringToArray(string),
      chrSymbols = stringToArray(chars),
      start = charsStartIndex(strSymbols, chrSymbols),
      end = charsEndIndex(strSymbols, chrSymbols) + 1;

  return castSlice(strSymbols, start, end).join('');
}

var FN_ARGS = /^(?:async\s+)?(function)?\s*[^\(]*\(\s*([^\)]*)\)/m;
var FN_ARG_SPLIT = /,/;
var FN_ARG = /(=.+)?(\s*)$/;
var STRIP_COMMENTS = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg;

function parseParams(func) {
    func = func.toString().replace(STRIP_COMMENTS, '');
    func = func.match(FN_ARGS)[2].replace(' ', '');
    func = func ? func.split(FN_ARG_SPLIT) : [];
    func = func.map(function (arg){
        return trim(arg.replace(FN_ARG, ''));
    });
    return func;
}

/**
 * A dependency-injected version of the [async.auto]{@link module:ControlFlow.auto} function. Dependent
 * tasks are specified as parameters to the function, after the usual callback
 * parameter, with the parameter names matching the names of the tasks it
 * depends on. This can provide even more readable task graphs which can be
 * easier to maintain.
 *
 * If a final callback is specified, the task results are similarly injected,
 * specified as named parameters after the initial error parameter.
 *
 * The autoInject function is purely syntactic sugar and its semantics are
 * otherwise equivalent to [async.auto]{@link module:ControlFlow.auto}.
 *
 * @name autoInject
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.auto]{@link module:ControlFlow.auto}
 * @category Control Flow
 * @param {Object} tasks - An object, each of whose properties is an {@link AsyncFunction} of
 * the form 'func([dependencies...], callback). The object's key of a property
 * serves as the name of the task defined by that property, i.e. can be used
 * when specifying requirements for other tasks.
 * * The `callback` parameter is a `callback(err, result)` which must be called
 *   when finished, passing an `error` (which can be `null`) and the result of
 *   the function's execution. The remaining parameters name other tasks on
 *   which the task is dependent, and the results from those tasks are the
 *   arguments of those parameters.
 * @param {Function} [callback] - An optional callback which is called when all
 * the tasks have been completed. It receives the `err` argument if any `tasks`
 * pass an error to their callback, and a `results` object with any completed
 * task results, similar to `auto`.
 * @example
 *
 * //  The example from `auto` can be rewritten as follows:
 * async.autoInject({
 *     get_data: function(callback) {
 *         // async code to get some data
 *         callback(null, 'data', 'converted to array');
 *     },
 *     make_folder: function(callback) {
 *         // async code to create a directory to store a file in
 *         // this is run at the same time as getting the data
 *         callback(null, 'folder');
 *     },
 *     write_file: function(get_data, make_folder, callback) {
 *         // once there is some data and the directory exists,
 *         // write the data to a file in the directory
 *         callback(null, 'filename');
 *     },
 *     email_link: function(write_file, callback) {
 *         // once the file is written let's email a link to it...
 *         // write_file contains the filename returned by write_file.
 *         callback(null, {'file':write_file, 'email':'user@example.com'});
 *     }
 * }, function(err, results) {
 *     console.log('err = ', err);
 *     console.log('email_link = ', results.email_link);
 * });
 *
 * // If you are using a JS minifier that mangles parameter names, `autoInject`
 * // will not work with plain functions, since the parameter names will be
 * // collapsed to a single letter identifier.  To work around this, you can
 * // explicitly specify the names of the parameters your task function needs
 * // in an array, similar to Angular.js dependency injection.
 *
 * // This still has an advantage over plain `auto`, since the results a task
 * // depends on are still spread into arguments.
 * async.autoInject({
 *     //...
 *     write_file: ['get_data', 'make_folder', function(get_data, make_folder, callback) {
 *         callback(null, 'filename');
 *     }],
 *     email_link: ['write_file', function(write_file, callback) {
 *         callback(null, {'file':write_file, 'email':'user@example.com'});
 *     }]
 *     //...
 * }, function(err, results) {
 *     console.log('err = ', err);
 *     console.log('email_link = ', results.email_link);
 * });
 */
function autoInject(tasks, callback) {
    var newTasks = {};

    baseForOwn(tasks, function (taskFn, key) {
        var params;
        var fnIsAsync = isAsync(taskFn);
        var hasNoDeps =
            (!fnIsAsync && taskFn.length === 1) ||
            (fnIsAsync && taskFn.length === 0);

        if (isArray(taskFn)) {
            params = taskFn.slice(0, -1);
            taskFn = taskFn[taskFn.length - 1];

            newTasks[key] = params.concat(params.length > 0 ? newTask : taskFn);
        } else if (hasNoDeps) {
            // no dependencies, use the function as-is
            newTasks[key] = taskFn;
        } else {
            params = parseParams(taskFn);
            if (taskFn.length === 0 && !fnIsAsync && params.length === 0) {
                throw new Error("autoInject task functions require explicit parameters.");
            }

            // remove callback param
            if (!fnIsAsync) params.pop();

            newTasks[key] = params.concat(newTask);
        }

        function newTask(results, taskCb) {
            var newArgs = arrayMap(params, function (name) {
                return results[name];
            });
            newArgs.push(taskCb);
            wrapAsync(taskFn).apply(null, newArgs);
        }
    });

    auto(newTasks, callback);
}

// Simple doubly linked list (https://en.wikipedia.org/wiki/Doubly_linked_list) implementation
// used for queues. This implementation assumes that the node provided by the user can be modified
// to adjust the next and last properties. We implement only the minimal functionality
// for queue support.
function DLL() {
    this.head = this.tail = null;
    this.length = 0;
}

function setInitial(dll, node) {
    dll.length = 1;
    dll.head = dll.tail = node;
}

DLL.prototype.removeLink = function(node) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;

    node.prev = node.next = null;
    this.length -= 1;
    return node;
};

DLL.prototype.empty = function () {
    while(this.head) this.shift();
    return this;
};

DLL.prototype.insertAfter = function(node, newNode) {
    newNode.prev = node;
    newNode.next = node.next;
    if (node.next) node.next.prev = newNode;
    else this.tail = newNode;
    node.next = newNode;
    this.length += 1;
};

DLL.prototype.insertBefore = function(node, newNode) {
    newNode.prev = node.prev;
    newNode.next = node;
    if (node.prev) node.prev.next = newNode;
    else this.head = newNode;
    node.prev = newNode;
    this.length += 1;
};

DLL.prototype.unshift = function(node) {
    if (this.head) this.insertBefore(this.head, node);
    else setInitial(this, node);
};

DLL.prototype.push = function(node) {
    if (this.tail) this.insertAfter(this.tail, node);
    else setInitial(this, node);
};

DLL.prototype.shift = function() {
    return this.head && this.removeLink(this.head);
};

DLL.prototype.pop = function() {
    return this.tail && this.removeLink(this.tail);
};

DLL.prototype.toArray = function () {
    var arr = Array(this.length);
    var curr = this.head;
    for(var idx = 0; idx < this.length; idx++) {
        arr[idx] = curr.data;
        curr = curr.next;
    }
    return arr;
};

DLL.prototype.remove = function (testFn) {
    var curr = this.head;
    while(!!curr) {
        var next = curr.next;
        if (testFn(curr)) {
            this.removeLink(curr);
        }
        curr = next;
    }
    return this;
};

function queue(worker, concurrency, payload) {
    if (concurrency == null) {
        concurrency = 1;
    }
    else if(concurrency === 0) {
        throw new Error('Concurrency must not be zero');
    }

    var _worker = wrapAsync(worker);
    var numRunning = 0;
    var workersList = [];

    var processingScheduled = false;
    function _insert(data, insertAtFront, callback) {
        if (callback != null && typeof callback !== 'function') {
            throw new Error('task callback must be a function');
        }
        q.started = true;
        if (!isArray(data)) {
            data = [data];
        }
        if (data.length === 0 && q.idle()) {
            // call drain immediately if there are no tasks
            return setImmediate$1(function() {
                q.drain();
            });
        }

        for (var i = 0, l = data.length; i < l; i++) {
            var item = {
                data: data[i],
                callback: callback || noop
            };

            if (insertAtFront) {
                q._tasks.unshift(item);
            } else {
                q._tasks.push(item);
            }
        }

        if (!processingScheduled) {
            processingScheduled = true;
            setImmediate$1(function() {
                processingScheduled = false;
                q.process();
            });
        }
    }

    function _next(tasks) {
        return function(err){
            numRunning -= 1;

            for (var i = 0, l = tasks.length; i < l; i++) {
                var task = tasks[i];

                var index = baseIndexOf(workersList, task, 0);
                if (index === 0) {
                    workersList.shift();
                } else if (index > 0) {
                    workersList.splice(index, 1);
                }

                task.callback.apply(task, arguments);

                if (err != null) {
                    q.error(err, task.data);
                }
            }

            if (numRunning <= (q.concurrency - q.buffer) ) {
                q.unsaturated();
            }

            if (q.idle()) {
                q.drain();
            }
            q.process();
        };
    }

    var isProcessing = false;
    var q = {
        _tasks: new DLL(),
        concurrency: concurrency,
        payload: payload,
        saturated: noop,
        unsaturated:noop,
        buffer: concurrency / 4,
        empty: noop,
        drain: noop,
        error: noop,
        started: false,
        paused: false,
        push: function (data, callback) {
            _insert(data, false, callback);
        },
        kill: function () {
            q.drain = noop;
            q._tasks.empty();
        },
        unshift: function (data, callback) {
            _insert(data, true, callback);
        },
        remove: function (testFn) {
            q._tasks.remove(testFn);
        },
        process: function () {
            // Avoid trying to start too many processing operations. This can occur
            // when callbacks resolve synchronously (#1267).
            if (isProcessing) {
                return;
            }
            isProcessing = true;
            while(!q.paused && numRunning < q.concurrency && q._tasks.length){
                var tasks = [], data = [];
                var l = q._tasks.length;
                if (q.payload) l = Math.min(l, q.payload);
                for (var i = 0; i < l; i++) {
                    var node = q._tasks.shift();
                    tasks.push(node);
                    workersList.push(node);
                    data.push(node.data);
                }

                numRunning += 1;

                if (q._tasks.length === 0) {
                    q.empty();
                }

                if (numRunning === q.concurrency) {
                    q.saturated();
                }

                var cb = onlyOnce(_next(tasks));
                _worker(data, cb);
            }
            isProcessing = false;
        },
        length: function () {
            return q._tasks.length;
        },
        running: function () {
            return numRunning;
        },
        workersList: function () {
            return workersList;
        },
        idle: function() {
            return q._tasks.length + numRunning === 0;
        },
        pause: function () {
            q.paused = true;
        },
        resume: function () {
            if (q.paused === false) { return; }
            q.paused = false;
            setImmediate$1(q.process);
        }
    };
    return q;
}

/**
 * A cargo of tasks for the worker function to complete. Cargo inherits all of
 * the same methods and event callbacks as [`queue`]{@link module:ControlFlow.queue}.
 * @typedef {Object} CargoObject
 * @memberOf module:ControlFlow
 * @property {Function} length - A function returning the number of items
 * waiting to be processed. Invoke like `cargo.length()`.
 * @property {number} payload - An `integer` for determining how many tasks
 * should be process per round. This property can be changed after a `cargo` is
 * created to alter the payload on-the-fly.
 * @property {Function} push - Adds `task` to the `queue`. The callback is
 * called once the `worker` has finished processing the task. Instead of a
 * single task, an array of `tasks` can be submitted. The respective callback is
 * used for every task in the list. Invoke like `cargo.push(task, [callback])`.
 * @property {Function} saturated - A callback that is called when the
 * `queue.length()` hits the concurrency and further tasks will be queued.
 * @property {Function} empty - A callback that is called when the last item
 * from the `queue` is given to a `worker`.
 * @property {Function} drain - A callback that is called when the last item
 * from the `queue` has returned from the `worker`.
 * @property {Function} idle - a function returning false if there are items
 * waiting or being processed, or true if not. Invoke like `cargo.idle()`.
 * @property {Function} pause - a function that pauses the processing of tasks
 * until `resume()` is called. Invoke like `cargo.pause()`.
 * @property {Function} resume - a function that resumes the processing of
 * queued tasks when the queue is paused. Invoke like `cargo.resume()`.
 * @property {Function} kill - a function that removes the `drain` callback and
 * empties remaining tasks from the queue forcing it to go idle. Invoke like `cargo.kill()`.
 */

/**
 * Creates a `cargo` object with the specified payload. Tasks added to the
 * cargo will be processed altogether (up to the `payload` limit). If the
 * `worker` is in progress, the task is queued until it becomes available. Once
 * the `worker` has completed some tasks, each callback of those tasks is
 * called. Check out [these](https://camo.githubusercontent.com/6bbd36f4cf5b35a0f11a96dcd2e97711ffc2fb37/68747470733a2f2f662e636c6f75642e6769746875622e636f6d2f6173736574732f313637363837312f36383130382f62626330636662302d356632392d313165322d393734662d3333393763363464633835382e676966) [animations](https://camo.githubusercontent.com/f4810e00e1c5f5f8addbe3e9f49064fd5d102699/68747470733a2f2f662e636c6f75642e6769746875622e636f6d2f6173736574732f313637363837312f36383130312f38346339323036362d356632392d313165322d383134662d3964336430323431336266642e676966)
 * for how `cargo` and `queue` work.
 *
 * While [`queue`]{@link module:ControlFlow.queue} passes only one task to one of a group of workers
 * at a time, cargo passes an array of tasks to a single worker, repeating
 * when the worker is finished.
 *
 * @name cargo
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.queue]{@link module:ControlFlow.queue}
 * @category Control Flow
 * @param {AsyncFunction} worker - An asynchronous function for processing an array
 * of queued tasks. Invoked with `(tasks, callback)`.
 * @param {number} [payload=Infinity] - An optional `integer` for determining
 * how many tasks should be processed per round; if omitted, the default is
 * unlimited.
 * @returns {module:ControlFlow.CargoObject} A cargo object to manage the tasks. Callbacks can
 * attached as certain properties to listen for specific events during the
 * lifecycle of the cargo and inner queue.
 * @example
 *
 * // create a cargo object with payload 2
 * var cargo = async.cargo(function(tasks, callback) {
 *     for (var i=0; i<tasks.length; i++) {
 *         console.log('hello ' + tasks[i].name);
 *     }
 *     callback();
 * }, 2);
 *
 * // add some items
 * cargo.push({name: 'foo'}, function(err) {
 *     console.log('finished processing foo');
 * });
 * cargo.push({name: 'bar'}, function(err) {
 *     console.log('finished processing bar');
 * });
 * cargo.push({name: 'baz'}, function(err) {
 *     console.log('finished processing baz');
 * });
 */
function cargo(worker, payload) {
    return queue(worker, 1, payload);
}

/**
 * The same as [`eachOf`]{@link module:Collections.eachOf} but runs only a single async operation at a time.
 *
 * @name eachOfSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.eachOf]{@link module:Collections.eachOf}
 * @alias forEachOfSeries
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * Invoked with (item, key, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Invoked with (err).
 */
var eachOfSeries = doLimit(eachOfLimit, 1);

/**
 * Reduces `coll` into a single value using an async `iteratee` to return each
 * successive step. `memo` is the initial state of the reduction. This function
 * only operates in series.
 *
 * For performance reasons, it may make sense to split a call to this function
 * into a parallel map, and then use the normal `Array.prototype.reduce` on the
 * results. This function is for situations where each step in the reduction
 * needs to be async; if you can get the data before reducing it, then it's
 * probably a good idea to do so.
 *
 * @name reduce
 * @static
 * @memberOf module:Collections
 * @method
 * @alias inject
 * @alias foldl
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {*} memo - The initial state of the reduction.
 * @param {AsyncFunction} iteratee - A function applied to each item in the
 * array to produce the next step in the reduction.
 * The `iteratee` should complete with the next state of the reduction.
 * If the iteratee complete with an error, the reduction is stopped and the
 * main `callback` is immediately called with the error.
 * Invoked with (memo, item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Result is the reduced value. Invoked with
 * (err, result).
 * @example
 *
 * async.reduce([1,2,3], 0, function(memo, item, callback) {
 *     // pointless async:
 *     process.nextTick(function() {
 *         callback(null, memo + item)
 *     });
 * }, function(err, result) {
 *     // result is now equal to the last value of memo, which is 6
 * });
 */
function reduce(coll, memo, iteratee, callback) {
    callback = once(callback || noop);
    var _iteratee = wrapAsync(iteratee);
    eachOfSeries(coll, function(x, i, callback) {
        _iteratee(memo, x, function(err, v) {
            memo = v;
            callback(err);
        });
    }, function(err) {
        callback(err, memo);
    });
}

/**
 * Version of the compose function that is more natural to read. Each function
 * consumes the return value of the previous function. It is the equivalent of
 * [compose]{@link module:ControlFlow.compose} with the arguments reversed.
 *
 * Each function is executed with the `this` binding of the composed function.
 *
 * @name seq
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.compose]{@link module:ControlFlow.compose}
 * @category Control Flow
 * @param {...AsyncFunction} functions - the asynchronous functions to compose
 * @returns {Function} a function that composes the `functions` in order
 * @example
 *
 * // Requires lodash (or underscore), express3 and dresende's orm2.
 * // Part of an app, that fetches cats of the logged user.
 * // This example uses `seq` function to avoid overnesting and error
 * // handling clutter.
 * app.get('/cats', function(request, response) {
 *     var User = request.models.User;
 *     async.seq(
 *         _.bind(User.get, User),  // 'User.get' has signature (id, callback(err, data))
 *         function(user, fn) {
 *             user.getCats(fn);      // 'getCats' has signature (callback(err, data))
 *         }
 *     )(req.session.user_id, function (err, cats) {
 *         if (err) {
 *             console.error(err);
 *             response.json({ status: 'error', message: err.message });
 *         } else {
 *             response.json({ status: 'ok', message: 'Cats found', data: cats });
 *         }
 *     });
 * });
 */
function seq(/*...functions*/) {
    var _functions = arrayMap(arguments, wrapAsync);
    return function(/*...args*/) {
        var args = slice(arguments);
        var that = this;

        var cb = args[args.length - 1];
        if (typeof cb == 'function') {
            args.pop();
        } else {
            cb = noop;
        }

        reduce(_functions, args, function(newargs, fn, cb) {
            fn.apply(that, newargs.concat(function(err/*, ...nextargs*/) {
                var nextargs = slice(arguments, 1);
                cb(err, nextargs);
            }));
        },
        function(err, results) {
            cb.apply(that, [err].concat(results));
        });
    };
}

/**
 * Creates a function which is a composition of the passed asynchronous
 * functions. Each function consumes the return value of the function that
 * follows. Composing functions `f()`, `g()`, and `h()` would produce the result
 * of `f(g(h()))`, only this version uses callbacks to obtain the return values.
 *
 * Each function is executed with the `this` binding of the composed function.
 *
 * @name compose
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {...AsyncFunction} functions - the asynchronous functions to compose
 * @returns {Function} an asynchronous function that is the composed
 * asynchronous `functions`
 * @example
 *
 * function add1(n, callback) {
 *     setTimeout(function () {
 *         callback(null, n + 1);
 *     }, 10);
 * }
 *
 * function mul3(n, callback) {
 *     setTimeout(function () {
 *         callback(null, n * 3);
 *     }, 10);
 * }
 *
 * var add1mul3 = async.compose(mul3, add1);
 * add1mul3(4, function (err, result) {
 *     // result now equals 15
 * });
 */
var compose = function(/*...args*/) {
    return seq.apply(null, slice(arguments).reverse());
};

var _concat = Array.prototype.concat;

/**
 * The same as [`concat`]{@link module:Collections.concat} but runs a maximum of `limit` async operations at a time.
 *
 * @name concatLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.concat]{@link module:Collections.concat}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - A function to apply to each item in `coll`,
 * which should use an array as its result. Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished, or an error occurs. Results is an array
 * containing the concatenated results of the `iteratee` function. Invoked with
 * (err, results).
 */
var concatLimit = function(coll, limit, iteratee, callback) {
    callback = callback || noop;
    var _iteratee = wrapAsync(iteratee);
    mapLimit(coll, limit, function(val, callback) {
        _iteratee(val, function(err /*, ...args*/) {
            if (err) return callback(err);
            return callback(null, slice(arguments, 1));
        });
    }, function(err, mapResults) {
        var result = [];
        for (var i = 0; i < mapResults.length; i++) {
            if (mapResults[i]) {
                result = _concat.apply(result, mapResults[i]);
            }
        }

        return callback(err, result);
    });
};

/**
 * Applies `iteratee` to each item in `coll`, concatenating the results. Returns
 * the concatenated list. The `iteratee`s are called in parallel, and the
 * results are concatenated as they return. There is no guarantee that the
 * results array will be returned in the original order of `coll` passed to the
 * `iteratee` function.
 *
 * @name concat
 * @static
 * @memberOf module:Collections
 * @method
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A function to apply to each item in `coll`,
 * which should use an array as its result. Invoked with (item, callback).
 * @param {Function} [callback(err)] - A callback which is called after all the
 * `iteratee` functions have finished, or an error occurs. Results is an array
 * containing the concatenated results of the `iteratee` function. Invoked with
 * (err, results).
 * @example
 *
 * async.concat(['dir1','dir2','dir3'], fs.readdir, function(err, files) {
 *     // files is now a list of filenames that exist in the 3 directories
 * });
 */
var concat = doLimit(concatLimit, Infinity);

/**
 * The same as [`concat`]{@link module:Collections.concat} but runs only a single async operation at a time.
 *
 * @name concatSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.concat]{@link module:Collections.concat}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A function to apply to each item in `coll`.
 * The iteratee should complete with an array an array of results.
 * Invoked with (item, callback).
 * @param {Function} [callback(err)] - A callback which is called after all the
 * `iteratee` functions have finished, or an error occurs. Results is an array
 * containing the concatenated results of the `iteratee` function. Invoked with
 * (err, results).
 */
var concatSeries = doLimit(concatLimit, 1);

/**
 * Returns a function that when called, calls-back with the values provided.
 * Useful as the first function in a [`waterfall`]{@link module:ControlFlow.waterfall}, or for plugging values in to
 * [`auto`]{@link module:ControlFlow.auto}.
 *
 * @name constant
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {...*} arguments... - Any number of arguments to automatically invoke
 * callback with.
 * @returns {AsyncFunction} Returns a function that when invoked, automatically
 * invokes the callback with the previous given arguments.
 * @example
 *
 * async.waterfall([
 *     async.constant(42),
 *     function (value, next) {
 *         // value === 42
 *     },
 *     //...
 * ], callback);
 *
 * async.waterfall([
 *     async.constant(filename, "utf8"),
 *     fs.readFile,
 *     function (fileData, next) {
 *         //...
 *     }
 *     //...
 * ], callback);
 *
 * async.auto({
 *     hostname: async.constant("https://server.net/"),
 *     port: findFreePort,
 *     launchServer: ["hostname", "port", function (options, cb) {
 *         startServer(options, cb);
 *     }],
 *     //...
 * }, callback);
 */
var constant = function(/*...values*/) {
    var values = slice(arguments);
    var args = [null].concat(values);
    return function (/*...ignoredArgs, callback*/) {
        var callback = arguments[arguments.length - 1];
        return callback.apply(this, args);
    };
};

/**
 * This method returns the first argument it receives.
 *
 * @static
 * @since 0.1.0
 * @memberOf _
 * @category Util
 * @param {*} value Any value.
 * @returns {*} Returns `value`.
 * @example
 *
 * var object = { 'a': 1 };
 *
 * console.log(_.identity(object) === object);
 * // => true
 */
function identity(value) {
  return value;
}

function _createTester(check, getResult) {
    return function(eachfn, arr, iteratee, cb) {
        cb = cb || noop;
        var testPassed = false;
        var testResult;
        eachfn(arr, function(value, _, callback) {
            iteratee(value, function(err, result) {
                if (err) {
                    callback(err);
                } else if (check(result) && !testResult) {
                    testPassed = true;
                    testResult = getResult(true, value);
                    callback(null, breakLoop);
                } else {
                    callback();
                }
            });
        }, function(err) {
            if (err) {
                cb(err);
            } else {
                cb(null, testPassed ? testResult : getResult(false));
            }
        });
    };
}

function _findGetResult(v, x) {
    return x;
}

/**
 * Returns the first value in `coll` that passes an async truth test. The
 * `iteratee` is applied in parallel, meaning the first iteratee to return
 * `true` will fire the detect `callback` with that result. That means the
 * result might not be the first item in the original `coll` (in terms of order)
 * that passes the test.

 * If order within the original `coll` is important, then look at
 * [`detectSeries`]{@link module:Collections.detectSeries}.
 *
 * @name detect
 * @static
 * @memberOf module:Collections
 * @method
 * @alias find
 * @category Collections
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A truth test to apply to each item in `coll`.
 * The iteratee must complete with a boolean value as its result.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called as soon as any
 * iteratee returns `true`, or after all the `iteratee` functions have finished.
 * Result will be the first item in the array that passes the truth test
 * (iteratee) or the value `undefined` if none passed. Invoked with
 * (err, result).
 * @example
 *
 * async.detect(['file1','file2','file3'], function(filePath, callback) {
 *     fs.access(filePath, function(err) {
 *         callback(null, !err)
 *     });
 * }, function(err, result) {
 *     // result now equals the first file in the list that exists
 * });
 */
var detect = doParallel(_createTester(identity, _findGetResult));

/**
 * The same as [`detect`]{@link module:Collections.detect} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name detectLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.detect]{@link module:Collections.detect}
 * @alias findLimit
 * @category Collections
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - A truth test to apply to each item in `coll`.
 * The iteratee must complete with a boolean value as its result.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called as soon as any
 * iteratee returns `true`, or after all the `iteratee` functions have finished.
 * Result will be the first item in the array that passes the truth test
 * (iteratee) or the value `undefined` if none passed. Invoked with
 * (err, result).
 */
var detectLimit = doParallelLimit(_createTester(identity, _findGetResult));

/**
 * The same as [`detect`]{@link module:Collections.detect} but runs only a single async operation at a time.
 *
 * @name detectSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.detect]{@link module:Collections.detect}
 * @alias findSeries
 * @category Collections
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A truth test to apply to each item in `coll`.
 * The iteratee must complete with a boolean value as its result.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called as soon as any
 * iteratee returns `true`, or after all the `iteratee` functions have finished.
 * Result will be the first item in the array that passes the truth test
 * (iteratee) or the value `undefined` if none passed. Invoked with
 * (err, result).
 */
var detectSeries = doLimit(detectLimit, 1);

function consoleFunc(name) {
    return function (fn/*, ...args*/) {
        var args = slice(arguments, 1);
        args.push(function (err/*, ...args*/) {
            var args = slice(arguments, 1);
            if (typeof console === 'object') {
                if (err) {
                    if (console.error) {
                        console.error(err);
                    }
                } else if (console[name]) {
                    arrayEach(args, function (x) {
                        console[name](x);
                    });
                }
            }
        });
        wrapAsync(fn).apply(null, args);
    };
}

/**
 * Logs the result of an [`async` function]{@link AsyncFunction} to the
 * `console` using `console.dir` to display the properties of the resulting object.
 * Only works in Node.js or in browsers that support `console.dir` and
 * `console.error` (such as FF and Chrome).
 * If multiple arguments are returned from the async function,
 * `console.dir` is called on each argument in order.
 *
 * @name dir
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {AsyncFunction} function - The function you want to eventually apply
 * all arguments to.
 * @param {...*} arguments... - Any number of arguments to apply to the function.
 * @example
 *
 * // in a module
 * var hello = function(name, callback) {
 *     setTimeout(function() {
 *         callback(null, {hello: name});
 *     }, 1000);
 * };
 *
 * // in the node repl
 * node> async.dir(hello, 'world');
 * {hello: 'world'}
 */
var dir = consoleFunc('dir');

/**
 * The post-check version of [`during`]{@link module:ControlFlow.during}. To reflect the difference in
 * the order of operations, the arguments `test` and `fn` are switched.
 *
 * Also a version of [`doWhilst`]{@link module:ControlFlow.doWhilst} with asynchronous `test` function.
 * @name doDuring
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.during]{@link module:ControlFlow.during}
 * @category Control Flow
 * @param {AsyncFunction} fn - An async function which is called each time
 * `test` passes. Invoked with (callback).
 * @param {AsyncFunction} test - asynchronous truth test to perform before each
 * execution of `fn`. Invoked with (...args, callback), where `...args` are the
 * non-error args from the previous callback of `fn`.
 * @param {Function} [callback] - A callback which is called after the test
 * function has failed and repeated execution of `fn` has stopped. `callback`
 * will be passed an error if one occurred, otherwise `null`.
 */
function doDuring(fn, test, callback) {
    callback = onlyOnce(callback || noop);
    var _fn = wrapAsync(fn);
    var _test = wrapAsync(test);

    function next(err/*, ...args*/) {
        if (err) return callback(err);
        var args = slice(arguments, 1);
        args.push(check);
        _test.apply(this, args);
    }

    function check(err, truth) {
        if (err) return callback(err);
        if (!truth) return callback(null);
        _fn(next);
    }

    check(null, true);

}

/**
 * The post-check version of [`whilst`]{@link module:ControlFlow.whilst}. To reflect the difference in
 * the order of operations, the arguments `test` and `iteratee` are switched.
 *
 * `doWhilst` is to `whilst` as `do while` is to `while` in plain JavaScript.
 *
 * @name doWhilst
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.whilst]{@link module:ControlFlow.whilst}
 * @category Control Flow
 * @param {AsyncFunction} iteratee - A function which is called each time `test`
 * passes. Invoked with (callback).
 * @param {Function} test - synchronous truth test to perform after each
 * execution of `iteratee`. Invoked with any non-error callback results of
 * `iteratee`.
 * @param {Function} [callback] - A callback which is called after the test
 * function has failed and repeated execution of `iteratee` has stopped.
 * `callback` will be passed an error and any arguments passed to the final
 * `iteratee`'s callback. Invoked with (err, [results]);
 */
function doWhilst(iteratee, test, callback) {
    callback = onlyOnce(callback || noop);
    var _iteratee = wrapAsync(iteratee);
    var next = function(err/*, ...args*/) {
        if (err) return callback(err);
        var args = slice(arguments, 1);
        if (test.apply(this, args)) return _iteratee(next);
        callback.apply(null, [null].concat(args));
    };
    _iteratee(next);
}

/**
 * Like ['doWhilst']{@link module:ControlFlow.doWhilst}, except the `test` is inverted. Note the
 * argument ordering differs from `until`.
 *
 * @name doUntil
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.doWhilst]{@link module:ControlFlow.doWhilst}
 * @category Control Flow
 * @param {AsyncFunction} iteratee - An async function which is called each time
 * `test` fails. Invoked with (callback).
 * @param {Function} test - synchronous truth test to perform after each
 * execution of `iteratee`. Invoked with any non-error callback results of
 * `iteratee`.
 * @param {Function} [callback] - A callback which is called after the test
 * function has passed and repeated execution of `iteratee` has stopped. `callback`
 * will be passed an error and any arguments passed to the final `iteratee`'s
 * callback. Invoked with (err, [results]);
 */
function doUntil(iteratee, test, callback) {
    doWhilst(iteratee, function() {
        return !test.apply(this, arguments);
    }, callback);
}

/**
 * Like [`whilst`]{@link module:ControlFlow.whilst}, except the `test` is an asynchronous function that
 * is passed a callback in the form of `function (err, truth)`. If error is
 * passed to `test` or `fn`, the main callback is immediately called with the
 * value of the error.
 *
 * @name during
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.whilst]{@link module:ControlFlow.whilst}
 * @category Control Flow
 * @param {AsyncFunction} test - asynchronous truth test to perform before each
 * execution of `fn`. Invoked with (callback).
 * @param {AsyncFunction} fn - An async function which is called each time
 * `test` passes. Invoked with (callback).
 * @param {Function} [callback] - A callback which is called after the test
 * function has failed and repeated execution of `fn` has stopped. `callback`
 * will be passed an error, if one occurred, otherwise `null`.
 * @example
 *
 * var count = 0;
 *
 * async.during(
 *     function (callback) {
 *         return callback(null, count < 5);
 *     },
 *     function (callback) {
 *         count++;
 *         setTimeout(callback, 1000);
 *     },
 *     function (err) {
 *         // 5 seconds have passed
 *     }
 * );
 */
function during(test, fn, callback) {
    callback = onlyOnce(callback || noop);
    var _fn = wrapAsync(fn);
    var _test = wrapAsync(test);

    function next(err) {
        if (err) return callback(err);
        _test(check);
    }

    function check(err, truth) {
        if (err) return callback(err);
        if (!truth) return callback(null);
        _fn(next);
    }

    _test(check);
}

function _withoutIndex(iteratee) {
    return function (value, index, callback) {
        return iteratee(value, callback);
    };
}

/**
 * Applies the function `iteratee` to each item in `coll`, in parallel.
 * The `iteratee` is called with an item from the list, and a callback for when
 * it has finished. If the `iteratee` passes an error to its `callback`, the
 * main `callback` (for the `each` function) is immediately called with the
 * error.
 *
 * Note, that since this function applies `iteratee` to each item in parallel,
 * there is no guarantee that the iteratee functions will complete in order.
 *
 * @name each
 * @static
 * @memberOf module:Collections
 * @method
 * @alias forEach
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to
 * each item in `coll`. Invoked with (item, callback).
 * The array index is not passed to the iteratee.
 * If you need the index, use `eachOf`.
 * @param {Function} [callback] - A callback which is called when all
 * `iteratee` functions have finished, or an error occurs. Invoked with (err).
 * @example
 *
 * // assuming openFiles is an array of file names and saveFile is a function
 * // to save the modified contents of that file:
 *
 * async.each(openFiles, saveFile, function(err){
 *   // if any of the saves produced an error, err would equal that error
 * });
 *
 * // assuming openFiles is an array of file names
 * async.each(openFiles, function(file, callback) {
 *
 *     // Perform operation on file here.
 *     console.log('Processing file ' + file);
 *
 *     if( file.length > 32 ) {
 *       console.log('This file name is too long');
 *       callback('File name too long');
 *     } else {
 *       // Do work to process file here
 *       console.log('File processed');
 *       callback();
 *     }
 * }, function(err) {
 *     // if any of the file processing produced an error, err would equal that error
 *     if( err ) {
 *       // One of the iterations produced an error.
 *       // All processing will now stop.
 *       console.log('A file failed to process');
 *     } else {
 *       console.log('All files have been processed successfully');
 *     }
 * });
 */
function eachLimit(coll, iteratee, callback) {
    eachOf(coll, _withoutIndex(wrapAsync(iteratee)), callback);
}

/**
 * The same as [`each`]{@link module:Collections.each} but runs a maximum of `limit` async operations at a time.
 *
 * @name eachLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.each]{@link module:Collections.each}
 * @alias forEachLimit
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The array index is not passed to the iteratee.
 * If you need the index, use `eachOfLimit`.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called when all
 * `iteratee` functions have finished, or an error occurs. Invoked with (err).
 */
function eachLimit$1(coll, limit, iteratee, callback) {
    _eachOfLimit(limit)(coll, _withoutIndex(wrapAsync(iteratee)), callback);
}

/**
 * The same as [`each`]{@link module:Collections.each} but runs only a single async operation at a time.
 *
 * @name eachSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.each]{@link module:Collections.each}
 * @alias forEachSeries
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to each
 * item in `coll`.
 * The array index is not passed to the iteratee.
 * If you need the index, use `eachOfSeries`.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called when all
 * `iteratee` functions have finished, or an error occurs. Invoked with (err).
 */
var eachSeries = doLimit(eachLimit$1, 1);

/**
 * Wrap an async function and ensure it calls its callback on a later tick of
 * the event loop.  If the function already calls its callback on a next tick,
 * no extra deferral is added. This is useful for preventing stack overflows
 * (`RangeError: Maximum call stack size exceeded`) and generally keeping
 * [Zalgo](http://blog.izs.me/post/59142742143/designing-apis-for-asynchrony)
 * contained. ES2017 `async` functions are returned as-is -- they are immune
 * to Zalgo's corrupting influences, as they always resolve on a later tick.
 *
 * @name ensureAsync
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {AsyncFunction} fn - an async function, one that expects a node-style
 * callback as its last argument.
 * @returns {AsyncFunction} Returns a wrapped function with the exact same call
 * signature as the function passed in.
 * @example
 *
 * function sometimesAsync(arg, callback) {
 *     if (cache[arg]) {
 *         return callback(null, cache[arg]); // this would be synchronous!!
 *     } else {
 *         doSomeIO(arg, callback); // this IO would be asynchronous
 *     }
 * }
 *
 * // this has a risk of stack overflows if many results are cached in a row
 * async.mapSeries(args, sometimesAsync, done);
 *
 * // this will defer sometimesAsync's callback if necessary,
 * // preventing stack overflows
 * async.mapSeries(args, async.ensureAsync(sometimesAsync), done);
 */
function ensureAsync(fn) {
    if (isAsync(fn)) return fn;
    return initialParams(function (args, callback) {
        var sync = true;
        args.push(function () {
            var innerArgs = arguments;
            if (sync) {
                setImmediate$1(function () {
                    callback.apply(null, innerArgs);
                });
            } else {
                callback.apply(null, innerArgs);
            }
        });
        fn.apply(this, args);
        sync = false;
    });
}

function notId(v) {
    return !v;
}

/**
 * Returns `true` if every element in `coll` satisfies an async test. If any
 * iteratee call returns `false`, the main `callback` is immediately called.
 *
 * @name every
 * @static
 * @memberOf module:Collections
 * @method
 * @alias all
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async truth test to apply to each item
 * in the collection in parallel.
 * The iteratee must complete with a boolean result value.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Result will be either `true` or `false`
 * depending on the values of the async tests. Invoked with (err, result).
 * @example
 *
 * async.every(['file1','file2','file3'], function(filePath, callback) {
 *     fs.access(filePath, function(err) {
 *         callback(null, !err)
 *     });
 * }, function(err, result) {
 *     // if result is true then every file exists
 * });
 */
var every = doParallel(_createTester(notId, notId));

/**
 * The same as [`every`]{@link module:Collections.every} but runs a maximum of `limit` async operations at a time.
 *
 * @name everyLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.every]{@link module:Collections.every}
 * @alias allLimit
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async truth test to apply to each item
 * in the collection in parallel.
 * The iteratee must complete with a boolean result value.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Result will be either `true` or `false`
 * depending on the values of the async tests. Invoked with (err, result).
 */
var everyLimit = doParallelLimit(_createTester(notId, notId));

/**
 * The same as [`every`]{@link module:Collections.every} but runs only a single async operation at a time.
 *
 * @name everySeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.every]{@link module:Collections.every}
 * @alias allSeries
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async truth test to apply to each item
 * in the collection in series.
 * The iteratee must complete with a boolean result value.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Result will be either `true` or `false`
 * depending on the values of the async tests. Invoked with (err, result).
 */
var everySeries = doLimit(everyLimit, 1);

/**
 * The base implementation of `_.property` without support for deep paths.
 *
 * @private
 * @param {string} key The key of the property to get.
 * @returns {Function} Returns the new accessor function.
 */
function baseProperty(key) {
  return function(object) {
    return object == null ? undefined : object[key];
  };
}

function filterArray(eachfn, arr, iteratee, callback) {
    var truthValues = new Array(arr.length);
    eachfn(arr, function (x, index, callback) {
        iteratee(x, function (err, v) {
            truthValues[index] = !!v;
            callback(err);
        });
    }, function (err) {
        if (err) return callback(err);
        var results = [];
        for (var i = 0; i < arr.length; i++) {
            if (truthValues[i]) results.push(arr[i]);
        }
        callback(null, results);
    });
}

function filterGeneric(eachfn, coll, iteratee, callback) {
    var results = [];
    eachfn(coll, function (x, index, callback) {
        iteratee(x, function (err, v) {
            if (err) {
                callback(err);
            } else {
                if (v) {
                    results.push({index: index, value: x});
                }
                callback();
            }
        });
    }, function (err) {
        if (err) {
            callback(err);
        } else {
            callback(null, arrayMap(results.sort(function (a, b) {
                return a.index - b.index;
            }), baseProperty('value')));
        }
    });
}

function _filter(eachfn, coll, iteratee, callback) {
    var filter = isArrayLike(coll) ? filterArray : filterGeneric;
    filter(eachfn, coll, wrapAsync(iteratee), callback || noop);
}

/**
 * Returns a new array of all the values in `coll` which pass an async truth
 * test. This operation is performed in parallel, but the results array will be
 * in the same order as the original.
 *
 * @name filter
 * @static
 * @memberOf module:Collections
 * @method
 * @alias select
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {Function} iteratee - A truth test to apply to each item in `coll`.
 * The `iteratee` is passed a `callback(err, truthValue)`, which must be called
 * with a boolean argument once it has completed. Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Invoked with (err, results).
 * @example
 *
 * async.filter(['file1','file2','file3'], function(filePath, callback) {
 *     fs.access(filePath, function(err) {
 *         callback(null, !err)
 *     });
 * }, function(err, results) {
 *     // results now equals an array of the existing files
 * });
 */
var filter = doParallel(_filter);

/**
 * The same as [`filter`]{@link module:Collections.filter} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name filterLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.filter]{@link module:Collections.filter}
 * @alias selectLimit
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {Function} iteratee - A truth test to apply to each item in `coll`.
 * The `iteratee` is passed a `callback(err, truthValue)`, which must be called
 * with a boolean argument once it has completed. Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Invoked with (err, results).
 */
var filterLimit = doParallelLimit(_filter);

/**
 * The same as [`filter`]{@link module:Collections.filter} but runs only a single async operation at a time.
 *
 * @name filterSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.filter]{@link module:Collections.filter}
 * @alias selectSeries
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {Function} iteratee - A truth test to apply to each item in `coll`.
 * The `iteratee` is passed a `callback(err, truthValue)`, which must be called
 * with a boolean argument once it has completed. Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Invoked with (err, results)
 */
var filterSeries = doLimit(filterLimit, 1);

/**
 * Calls the asynchronous function `fn` with a callback parameter that allows it
 * to call itself again, in series, indefinitely.

 * If an error is passed to the callback then `errback` is called with the
 * error, and execution stops, otherwise it will never be called.
 *
 * @name forever
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {AsyncFunction} fn - an async function to call repeatedly.
 * Invoked with (next).
 * @param {Function} [errback] - when `fn` passes an error to it's callback,
 * this function will be called, and execution stops. Invoked with (err).
 * @example
 *
 * async.forever(
 *     function(next) {
 *         // next is suitable for passing to things that need a callback(err [, whatever]);
 *         // it will result in this function being called again.
 *     },
 *     function(err) {
 *         // if next is called with a value in its first parameter, it will appear
 *         // in here as 'err', and execution will stop.
 *     }
 * );
 */
function forever(fn, errback) {
    var done = onlyOnce(errback || noop);
    var task = wrapAsync(ensureAsync(fn));

    function next(err) {
        if (err) return done(err);
        task(next);
    }
    next();
}

/**
 * The same as [`groupBy`]{@link module:Collections.groupBy} but runs a maximum of `limit` async operations at a time.
 *
 * @name groupByLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.groupBy]{@link module:Collections.groupBy}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with a `key` to group the value under.
 * Invoked with (value, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Result is an `Object` whoses
 * properties are arrays of values which returned the corresponding key.
 */
var groupByLimit = function(coll, limit, iteratee, callback) {
    callback = callback || noop;
    var _iteratee = wrapAsync(iteratee);
    mapLimit(coll, limit, function(val, callback) {
        _iteratee(val, function(err, key) {
            if (err) return callback(err);
            return callback(null, {key: key, val: val});
        });
    }, function(err, mapResults) {
        var result = {};
        // from MDN, handle object having an `hasOwnProperty` prop
        var hasOwnProperty = Object.prototype.hasOwnProperty;

        for (var i = 0; i < mapResults.length; i++) {
            if (mapResults[i]) {
                var key = mapResults[i].key;
                var val = mapResults[i].val;

                if (hasOwnProperty.call(result, key)) {
                    result[key].push(val);
                } else {
                    result[key] = [val];
                }
            }
        }

        return callback(err, result);
    });
};

/**
 * Returns a new object, where each value corresponds to an array of items, from
 * `coll`, that returned the corresponding key. That is, the keys of the object
 * correspond to the values passed to the `iteratee` callback.
 *
 * Note: Since this function applies the `iteratee` to each item in parallel,
 * there is no guarantee that the `iteratee` functions will complete in order.
 * However, the values for each key in the `result` will be in the same order as
 * the original `coll`. For Objects, the values will roughly be in the order of
 * the original Objects' keys (but this can vary across JavaScript engines).
 *
 * @name groupBy
 * @static
 * @memberOf module:Collections
 * @method
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with a `key` to group the value under.
 * Invoked with (value, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Result is an `Object` whoses
 * properties are arrays of values which returned the corresponding key.
 * @example
 *
 * async.groupBy(['userId1', 'userId2', 'userId3'], function(userId, callback) {
 *     db.findById(userId, function(err, user) {
 *         if (err) return callback(err);
 *         return callback(null, user.age);
 *     });
 * }, function(err, result) {
 *     // result is object containing the userIds grouped by age
 *     // e.g. { 30: ['userId1', 'userId3'], 42: ['userId2']};
 * });
 */
var groupBy = doLimit(groupByLimit, Infinity);

/**
 * The same as [`groupBy`]{@link module:Collections.groupBy} but runs only a single async operation at a time.
 *
 * @name groupBySeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.groupBy]{@link module:Collections.groupBy}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with a `key` to group the value under.
 * Invoked with (value, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. Result is an `Object` whoses
 * properties are arrays of values which returned the corresponding key.
 */
var groupBySeries = doLimit(groupByLimit, 1);

/**
 * Logs the result of an `async` function to the `console`. Only works in
 * Node.js or in browsers that support `console.log` and `console.error` (such
 * as FF and Chrome). If multiple arguments are returned from the async
 * function, `console.log` is called on each argument in order.
 *
 * @name log
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {AsyncFunction} function - The function you want to eventually apply
 * all arguments to.
 * @param {...*} arguments... - Any number of arguments to apply to the function.
 * @example
 *
 * // in a module
 * var hello = function(name, callback) {
 *     setTimeout(function() {
 *         callback(null, 'hello ' + name);
 *     }, 1000);
 * };
 *
 * // in the node repl
 * node> async.log(hello, 'world');
 * 'hello world'
 */
var log = consoleFunc('log');

/**
 * The same as [`mapValues`]{@link module:Collections.mapValues} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name mapValuesLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.mapValues]{@link module:Collections.mapValues}
 * @category Collection
 * @param {Object} obj - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - A function to apply to each value and key
 * in `coll`.
 * The iteratee should complete with the transformed value as its result.
 * Invoked with (value, key, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. `result` is a new object consisting
 * of each key from `obj`, with each transformed value on the right-hand side.
 * Invoked with (err, result).
 */
function mapValuesLimit(obj, limit, iteratee, callback) {
    callback = once(callback || noop);
    var newObj = {};
    var _iteratee = wrapAsync(iteratee);
    eachOfLimit(obj, limit, function(val, key, next) {
        _iteratee(val, key, function (err, result) {
            if (err) return next(err);
            newObj[key] = result;
            next();
        });
    }, function (err) {
        callback(err, newObj);
    });
}

/**
 * A relative of [`map`]{@link module:Collections.map}, designed for use with objects.
 *
 * Produces a new Object by mapping each value of `obj` through the `iteratee`
 * function. The `iteratee` is called each `value` and `key` from `obj` and a
 * callback for when it has finished processing. Each of these callbacks takes
 * two arguments: an `error`, and the transformed item from `obj`. If `iteratee`
 * passes an error to its callback, the main `callback` (for the `mapValues`
 * function) is immediately called with the error.
 *
 * Note, the order of the keys in the result is not guaranteed.  The keys will
 * be roughly in the order they complete, (but this is very engine-specific)
 *
 * @name mapValues
 * @static
 * @memberOf module:Collections
 * @method
 * @category Collection
 * @param {Object} obj - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A function to apply to each value and key
 * in `coll`.
 * The iteratee should complete with the transformed value as its result.
 * Invoked with (value, key, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. `result` is a new object consisting
 * of each key from `obj`, with each transformed value on the right-hand side.
 * Invoked with (err, result).
 * @example
 *
 * async.mapValues({
 *     f1: 'file1',
 *     f2: 'file2',
 *     f3: 'file3'
 * }, function (file, key, callback) {
 *   fs.stat(file, callback);
 * }, function(err, result) {
 *     // result is now a map of stats for each file, e.g.
 *     // {
 *     //     f1: [stats for file1],
 *     //     f2: [stats for file2],
 *     //     f3: [stats for file3]
 *     // }
 * });
 */

var mapValues = doLimit(mapValuesLimit, Infinity);

/**
 * The same as [`mapValues`]{@link module:Collections.mapValues} but runs only a single async operation at a time.
 *
 * @name mapValuesSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.mapValues]{@link module:Collections.mapValues}
 * @category Collection
 * @param {Object} obj - A collection to iterate over.
 * @param {AsyncFunction} iteratee - A function to apply to each value and key
 * in `coll`.
 * The iteratee should complete with the transformed value as its result.
 * Invoked with (value, key, callback).
 * @param {Function} [callback] - A callback which is called when all `iteratee`
 * functions have finished, or an error occurs. `result` is a new object consisting
 * of each key from `obj`, with each transformed value on the right-hand side.
 * Invoked with (err, result).
 */
var mapValuesSeries = doLimit(mapValuesLimit, 1);

function has(obj, key) {
    return key in obj;
}

/**
 * Caches the results of an async function. When creating a hash to store
 * function results against, the callback is omitted from the hash and an
 * optional hash function can be used.
 *
 * If no hash function is specified, the first argument is used as a hash key,
 * which may work reasonably if it is a string or a data type that converts to a
 * distinct string. Note that objects and arrays will not behave reasonably.
 * Neither will cases where the other arguments are significant. In such cases,
 * specify your own hash function.
 *
 * The cache of results is exposed as the `memo` property of the function
 * returned by `memoize`.
 *
 * @name memoize
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {AsyncFunction} fn - The async function to proxy and cache results from.
 * @param {Function} hasher - An optional function for generating a custom hash
 * for storing results. It has all the arguments applied to it apart from the
 * callback, and must be synchronous.
 * @returns {AsyncFunction} a memoized version of `fn`
 * @example
 *
 * var slow_fn = function(name, callback) {
 *     // do something
 *     callback(null, result);
 * };
 * var fn = async.memoize(slow_fn);
 *
 * // fn can now be used as if it were slow_fn
 * fn('some name', function() {
 *     // callback
 * });
 */
function memoize(fn, hasher) {
    var memo = Object.create(null);
    var queues = Object.create(null);
    hasher = hasher || identity;
    var _fn = wrapAsync(fn);
    var memoized = initialParams(function memoized(args, callback) {
        var key = hasher.apply(null, args);
        if (has(memo, key)) {
            setImmediate$1(function() {
                callback.apply(null, memo[key]);
            });
        } else if (has(queues, key)) {
            queues[key].push(callback);
        } else {
            queues[key] = [callback];
            _fn.apply(null, args.concat(function(/*args*/) {
                var args = slice(arguments);
                memo[key] = args;
                var q = queues[key];
                delete queues[key];
                for (var i = 0, l = q.length; i < l; i++) {
                    q[i].apply(null, args);
                }
            }));
        }
    });
    memoized.memo = memo;
    memoized.unmemoized = fn;
    return memoized;
}

/**
 * Calls `callback` on a later loop around the event loop. In Node.js this just
 * calls `process.nextTick`.  In the browser it will use `setImmediate` if
 * available, otherwise `setTimeout(callback, 0)`, which means other higher
 * priority events may precede the execution of `callback`.
 *
 * This is used internally for browser-compatibility purposes.
 *
 * @name nextTick
 * @static
 * @memberOf module:Utils
 * @method
 * @see [async.setImmediate]{@link module:Utils.setImmediate}
 * @category Util
 * @param {Function} callback - The function to call on a later loop around
 * the event loop. Invoked with (args...).
 * @param {...*} args... - any number of additional arguments to pass to the
 * callback on the next tick.
 * @example
 *
 * var call_order = [];
 * async.nextTick(function() {
 *     call_order.push('two');
 *     // call_order now equals ['one','two']
 * });
 * call_order.push('one');
 *
 * async.setImmediate(function (a, b, c) {
 *     // a, b, and c equal 1, 2, and 3
 * }, 1, 2, 3);
 */
var _defer$1;

if (hasNextTick) {
    _defer$1 = process.nextTick;
} else if (hasSetImmediate) {
    _defer$1 = setImmediate;
} else {
    _defer$1 = fallback;
}

var nextTick = wrap(_defer$1);

function _parallel(eachfn, tasks, callback) {
    callback = callback || noop;
    var results = isArrayLike(tasks) ? [] : {};

    eachfn(tasks, function (task, key, callback) {
        wrapAsync(task)(function (err, result) {
            if (arguments.length > 2) {
                result = slice(arguments, 1);
            }
            results[key] = result;
            callback(err);
        });
    }, function (err) {
        callback(err, results);
    });
}

/**
 * Run the `tasks` collection of functions in parallel, without waiting until
 * the previous function has completed. If any of the functions pass an error to
 * its callback, the main `callback` is immediately called with the value of the
 * error. Once the `tasks` have completed, the results are passed to the final
 * `callback` as an array.
 *
 * **Note:** `parallel` is about kicking-off I/O tasks in parallel, not about
 * parallel execution of code.  If your tasks do not use any timers or perform
 * any I/O, they will actually be executed in series.  Any synchronous setup
 * sections for each task will happen one after the other.  JavaScript remains
 * single-threaded.
 *
 * **Hint:** Use [`reflect`]{@link module:Utils.reflect} to continue the
 * execution of other tasks when a task fails.
 *
 * It is also possible to use an object instead of an array. Each property will
 * be run as a function and the results will be passed to the final `callback`
 * as an object instead of an array. This can be a more readable way of handling
 * results from {@link async.parallel}.
 *
 * @name parallel
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Array|Iterable|Object} tasks - A collection of
 * [async functions]{@link AsyncFunction} to run.
 * Each async function can complete with any number of optional `result` values.
 * @param {Function} [callback] - An optional callback to run once all the
 * functions have completed successfully. This function gets a results array
 * (or object) containing all the result arguments passed to the task callbacks.
 * Invoked with (err, results).
 *
 * @example
 * async.parallel([
 *     function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'one');
 *         }, 200);
 *     },
 *     function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'two');
 *         }, 100);
 *     }
 * ],
 * // optional callback
 * function(err, results) {
 *     // the results array will equal ['one','two'] even though
 *     // the second function had a shorter timeout.
 * });
 *
 * // an example using an object instead of an array
 * async.parallel({
 *     one: function(callback) {
 *         setTimeout(function() {
 *             callback(null, 1);
 *         }, 200);
 *     },
 *     two: function(callback) {
 *         setTimeout(function() {
 *             callback(null, 2);
 *         }, 100);
 *     }
 * }, function(err, results) {
 *     // results is now equals to: {one: 1, two: 2}
 * });
 */
function parallelLimit(tasks, callback) {
    _parallel(eachOf, tasks, callback);
}

/**
 * The same as [`parallel`]{@link module:ControlFlow.parallel} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name parallelLimit
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.parallel]{@link module:ControlFlow.parallel}
 * @category Control Flow
 * @param {Array|Iterable|Object} tasks - A collection of
 * [async functions]{@link AsyncFunction} to run.
 * Each async function can complete with any number of optional `result` values.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {Function} [callback] - An optional callback to run once all the
 * functions have completed successfully. This function gets a results array
 * (or object) containing all the result arguments passed to the task callbacks.
 * Invoked with (err, results).
 */
function parallelLimit$1(tasks, limit, callback) {
    _parallel(_eachOfLimit(limit), tasks, callback);
}

/**
 * A queue of tasks for the worker function to complete.
 * @typedef {Object} QueueObject
 * @memberOf module:ControlFlow
 * @property {Function} length - a function returning the number of items
 * waiting to be processed. Invoke with `queue.length()`.
 * @property {boolean} started - a boolean indicating whether or not any
 * items have been pushed and processed by the queue.
 * @property {Function} running - a function returning the number of items
 * currently being processed. Invoke with `queue.running()`.
 * @property {Function} workersList - a function returning the array of items
 * currently being processed. Invoke with `queue.workersList()`.
 * @property {Function} idle - a function returning false if there are items
 * waiting or being processed, or true if not. Invoke with `queue.idle()`.
 * @property {number} concurrency - an integer for determining how many `worker`
 * functions should be run in parallel. This property can be changed after a
 * `queue` is created to alter the concurrency on-the-fly.
 * @property {Function} push - add a new task to the `queue`. Calls `callback`
 * once the `worker` has finished processing the task. Instead of a single task,
 * a `tasks` array can be submitted. The respective callback is used for every
 * task in the list. Invoke with `queue.push(task, [callback])`,
 * @property {Function} unshift - add a new task to the front of the `queue`.
 * Invoke with `queue.unshift(task, [callback])`.
 * @property {Function} remove - remove items from the queue that match a test
 * function.  The test function will be passed an object with a `data` property,
 * and a `priority` property, if this is a
 * [priorityQueue]{@link module:ControlFlow.priorityQueue} object.
 * Invoked with `queue.remove(testFn)`, where `testFn` is of the form
 * `function ({data, priority}) {}` and returns a Boolean.
 * @property {Function} saturated - a callback that is called when the number of
 * running workers hits the `concurrency` limit, and further tasks will be
 * queued.
 * @property {Function} unsaturated - a callback that is called when the number
 * of running workers is less than the `concurrency` & `buffer` limits, and
 * further tasks will not be queued.
 * @property {number} buffer - A minimum threshold buffer in order to say that
 * the `queue` is `unsaturated`.
 * @property {Function} empty - a callback that is called when the last item
 * from the `queue` is given to a `worker`.
 * @property {Function} drain - a callback that is called when the last item
 * from the `queue` has returned from the `worker`.
 * @property {Function} error - a callback that is called when a task errors.
 * Has the signature `function(error, task)`.
 * @property {boolean} paused - a boolean for determining whether the queue is
 * in a paused state.
 * @property {Function} pause - a function that pauses the processing of tasks
 * until `resume()` is called. Invoke with `queue.pause()`.
 * @property {Function} resume - a function that resumes the processing of
 * queued tasks when the queue is paused. Invoke with `queue.resume()`.
 * @property {Function} kill - a function that removes the `drain` callback and
 * empties remaining tasks from the queue forcing it to go idle. No more tasks
 * should be pushed to the queue after calling this function. Invoke with `queue.kill()`.
 */

/**
 * Creates a `queue` object with the specified `concurrency`. Tasks added to the
 * `queue` are processed in parallel (up to the `concurrency` limit). If all
 * `worker`s are in progress, the task is queued until one becomes available.
 * Once a `worker` completes a `task`, that `task`'s callback is called.
 *
 * @name queue
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {AsyncFunction} worker - An async function for processing a queued task.
 * If you want to handle errors from an individual task, pass a callback to
 * `q.push()`. Invoked with (task, callback).
 * @param {number} [concurrency=1] - An `integer` for determining how many
 * `worker` functions should be run in parallel.  If omitted, the concurrency
 * defaults to `1`.  If the concurrency is `0`, an error is thrown.
 * @returns {module:ControlFlow.QueueObject} A queue object to manage the tasks. Callbacks can
 * attached as certain properties to listen for specific events during the
 * lifecycle of the queue.
 * @example
 *
 * // create a queue object with concurrency 2
 * var q = async.queue(function(task, callback) {
 *     console.log('hello ' + task.name);
 *     callback();
 * }, 2);
 *
 * // assign a callback
 * q.drain = function() {
 *     console.log('all items have been processed');
 * };
 *
 * // add some items to the queue
 * q.push({name: 'foo'}, function(err) {
 *     console.log('finished processing foo');
 * });
 * q.push({name: 'bar'}, function (err) {
 *     console.log('finished processing bar');
 * });
 *
 * // add some items to the queue (batch-wise)
 * q.push([{name: 'baz'},{name: 'bay'},{name: 'bax'}], function(err) {
 *     console.log('finished processing item');
 * });
 *
 * // add some items to the front of the queue
 * q.unshift({name: 'bar'}, function (err) {
 *     console.log('finished processing bar');
 * });
 */
var queue$1 = function (worker, concurrency) {
    var _worker = wrapAsync(worker);
    return queue(function (items, cb) {
        _worker(items[0], cb);
    }, concurrency, 1);
};

/**
 * The same as [async.queue]{@link module:ControlFlow.queue} only tasks are assigned a priority and
 * completed in ascending priority order.
 *
 * @name priorityQueue
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.queue]{@link module:ControlFlow.queue}
 * @category Control Flow
 * @param {AsyncFunction} worker - An async function for processing a queued task.
 * If you want to handle errors from an individual task, pass a callback to
 * `q.push()`.
 * Invoked with (task, callback).
 * @param {number} concurrency - An `integer` for determining how many `worker`
 * functions should be run in parallel.  If omitted, the concurrency defaults to
 * `1`.  If the concurrency is `0`, an error is thrown.
 * @returns {module:ControlFlow.QueueObject} A priorityQueue object to manage the tasks. There are two
 * differences between `queue` and `priorityQueue` objects:
 * * `push(task, priority, [callback])` - `priority` should be a number. If an
 *   array of `tasks` is given, all tasks will be assigned the same priority.
 * * The `unshift` method was removed.
 */
var priorityQueue = function(worker, concurrency) {
    // Start with a normal queue
    var q = queue$1(worker, concurrency);

    // Override push to accept second parameter representing priority
    q.push = function(data, priority, callback) {
        if (callback == null) callback = noop;
        if (typeof callback !== 'function') {
            throw new Error('task callback must be a function');
        }
        q.started = true;
        if (!isArray(data)) {
            data = [data];
        }
        if (data.length === 0) {
            // call drain immediately if there are no tasks
            return setImmediate$1(function() {
                q.drain();
            });
        }

        priority = priority || 0;
        var nextNode = q._tasks.head;
        while (nextNode && priority >= nextNode.priority) {
            nextNode = nextNode.next;
        }

        for (var i = 0, l = data.length; i < l; i++) {
            var item = {
                data: data[i],
                priority: priority,
                callback: callback
            };

            if (nextNode) {
                q._tasks.insertBefore(nextNode, item);
            } else {
                q._tasks.push(item);
            }
        }
        setImmediate$1(q.process);
    };

    // Remove unshift function
    delete q.unshift;

    return q;
};

/**
 * Runs the `tasks` array of functions in parallel, without waiting until the
 * previous function has completed. Once any of the `tasks` complete or pass an
 * error to its callback, the main `callback` is immediately called. It's
 * equivalent to `Promise.race()`.
 *
 * @name race
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Array} tasks - An array containing [async functions]{@link AsyncFunction}
 * to run. Each function can complete with an optional `result` value.
 * @param {Function} callback - A callback to run once any of the functions have
 * completed. This function gets an error or result from the first function that
 * completed. Invoked with (err, result).
 * @returns undefined
 * @example
 *
 * async.race([
 *     function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'one');
 *         }, 200);
 *     },
 *     function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'two');
 *         }, 100);
 *     }
 * ],
 * // main callback
 * function(err, result) {
 *     // the result will be equal to 'two' as it finishes earlier
 * });
 */
function race(tasks, callback) {
    callback = once(callback || noop);
    if (!isArray(tasks)) return callback(new TypeError('First argument to race must be an array of functions'));
    if (!tasks.length) return callback();
    for (var i = 0, l = tasks.length; i < l; i++) {
        wrapAsync(tasks[i])(callback);
    }
}

/**
 * Same as [`reduce`]{@link module:Collections.reduce}, only operates on `array` in reverse order.
 *
 * @name reduceRight
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.reduce]{@link module:Collections.reduce}
 * @alias foldr
 * @category Collection
 * @param {Array} array - A collection to iterate over.
 * @param {*} memo - The initial state of the reduction.
 * @param {AsyncFunction} iteratee - A function applied to each item in the
 * array to produce the next step in the reduction.
 * The `iteratee` should complete with the next state of the reduction.
 * If the iteratee complete with an error, the reduction is stopped and the
 * main `callback` is immediately called with the error.
 * Invoked with (memo, item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Result is the reduced value. Invoked with
 * (err, result).
 */
function reduceRight (array, memo, iteratee, callback) {
    var reversed = slice(array).reverse();
    reduce(reversed, memo, iteratee, callback);
}

/**
 * Wraps the async function in another function that always completes with a
 * result object, even when it errors.
 *
 * The result object has either the property `error` or `value`.
 *
 * @name reflect
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {AsyncFunction} fn - The async function you want to wrap
 * @returns {Function} - A function that always passes null to it's callback as
 * the error. The second argument to the callback will be an `object` with
 * either an `error` or a `value` property.
 * @example
 *
 * async.parallel([
 *     async.reflect(function(callback) {
 *         // do some stuff ...
 *         callback(null, 'one');
 *     }),
 *     async.reflect(function(callback) {
 *         // do some more stuff but error ...
 *         callback('bad stuff happened');
 *     }),
 *     async.reflect(function(callback) {
 *         // do some more stuff ...
 *         callback(null, 'two');
 *     })
 * ],
 * // optional callback
 * function(err, results) {
 *     // values
 *     // results[0].value = 'one'
 *     // results[1].error = 'bad stuff happened'
 *     // results[2].value = 'two'
 * });
 */
function reflect(fn) {
    var _fn = wrapAsync(fn);
    return initialParams(function reflectOn(args, reflectCallback) {
        args.push(function callback(error, cbArg) {
            if (error) {
                reflectCallback(null, { error: error });
            } else {
                var value;
                if (arguments.length <= 2) {
                    value = cbArg;
                } else {
                    value = slice(arguments, 1);
                }
                reflectCallback(null, { value: value });
            }
        });

        return _fn.apply(this, args);
    });
}

/**
 * A helper function that wraps an array or an object of functions with `reflect`.
 *
 * @name reflectAll
 * @static
 * @memberOf module:Utils
 * @method
 * @see [async.reflect]{@link module:Utils.reflect}
 * @category Util
 * @param {Array|Object|Iterable} tasks - The collection of
 * [async functions]{@link AsyncFunction} to wrap in `async.reflect`.
 * @returns {Array} Returns an array of async functions, each wrapped in
 * `async.reflect`
 * @example
 *
 * let tasks = [
 *     function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'one');
 *         }, 200);
 *     },
 *     function(callback) {
 *         // do some more stuff but error ...
 *         callback(new Error('bad stuff happened'));
 *     },
 *     function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'two');
 *         }, 100);
 *     }
 * ];
 *
 * async.parallel(async.reflectAll(tasks),
 * // optional callback
 * function(err, results) {
 *     // values
 *     // results[0].value = 'one'
 *     // results[1].error = Error('bad stuff happened')
 *     // results[2].value = 'two'
 * });
 *
 * // an example using an object instead of an array
 * let tasks = {
 *     one: function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'one');
 *         }, 200);
 *     },
 *     two: function(callback) {
 *         callback('two');
 *     },
 *     three: function(callback) {
 *         setTimeout(function() {
 *             callback(null, 'three');
 *         }, 100);
 *     }
 * };
 *
 * async.parallel(async.reflectAll(tasks),
 * // optional callback
 * function(err, results) {
 *     // values
 *     // results.one.value = 'one'
 *     // results.two.error = 'two'
 *     // results.three.value = 'three'
 * });
 */
function reflectAll(tasks) {
    var results;
    if (isArray(tasks)) {
        results = arrayMap(tasks, reflect);
    } else {
        results = {};
        baseForOwn(tasks, function(task, key) {
            results[key] = reflect.call(this, task);
        });
    }
    return results;
}

function reject$1(eachfn, arr, iteratee, callback) {
    _filter(eachfn, arr, function(value, cb) {
        iteratee(value, function(err, v) {
            cb(err, !v);
        });
    }, callback);
}

/**
 * The opposite of [`filter`]{@link module:Collections.filter}. Removes values that pass an `async` truth test.
 *
 * @name reject
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.filter]{@link module:Collections.filter}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {Function} iteratee - An async truth test to apply to each item in
 * `coll`.
 * The should complete with a boolean value as its `result`.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Invoked with (err, results).
 * @example
 *
 * async.reject(['file1','file2','file3'], function(filePath, callback) {
 *     fs.access(filePath, function(err) {
 *         callback(null, !err)
 *     });
 * }, function(err, results) {
 *     // results now equals an array of missing files
 *     createFiles(results);
 * });
 */
var reject = doParallel(reject$1);

/**
 * The same as [`reject`]{@link module:Collections.reject} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name rejectLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.reject]{@link module:Collections.reject}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {Function} iteratee - An async truth test to apply to each item in
 * `coll`.
 * The should complete with a boolean value as its `result`.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Invoked with (err, results).
 */
var rejectLimit = doParallelLimit(reject$1);

/**
 * The same as [`reject`]{@link module:Collections.reject} but runs only a single async operation at a time.
 *
 * @name rejectSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.reject]{@link module:Collections.reject}
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {Function} iteratee - An async truth test to apply to each item in
 * `coll`.
 * The should complete with a boolean value as its `result`.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Invoked with (err, results).
 */
var rejectSeries = doLimit(rejectLimit, 1);

/**
 * Creates a function that returns `value`.
 *
 * @static
 * @memberOf _
 * @since 2.4.0
 * @category Util
 * @param {*} value The value to return from the new function.
 * @returns {Function} Returns the new constant function.
 * @example
 *
 * var objects = _.times(2, _.constant({ 'a': 1 }));
 *
 * console.log(objects);
 * // => [{ 'a': 1 }, { 'a': 1 }]
 *
 * console.log(objects[0] === objects[1]);
 * // => true
 */
function constant$1(value) {
  return function() {
    return value;
  };
}

/**
 * Attempts to get a successful response from `task` no more than `times` times
 * before returning an error. If the task is successful, the `callback` will be
 * passed the result of the successful task. If all attempts fail, the callback
 * will be passed the error and result (if any) of the final attempt.
 *
 * @name retry
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @see [async.retryable]{@link module:ControlFlow.retryable}
 * @param {Object|number} [opts = {times: 5, interval: 0}| 5] - Can be either an
 * object with `times` and `interval` or a number.
 * * `times` - The number of attempts to make before giving up.  The default
 *   is `5`.
 * * `interval` - The time to wait between retries, in milliseconds.  The
 *   default is `0`. The interval may also be specified as a function of the
 *   retry count (see example).
 * * `errorFilter` - An optional synchronous function that is invoked on
 *   erroneous result. If it returns `true` the retry attempts will continue;
 *   if the function returns `false` the retry flow is aborted with the current
 *   attempt's error and result being returned to the final callback.
 *   Invoked with (err).
 * * If `opts` is a number, the number specifies the number of times to retry,
 *   with the default interval of `0`.
 * @param {AsyncFunction} task - An async function to retry.
 * Invoked with (callback).
 * @param {Function} [callback] - An optional callback which is called when the
 * task has succeeded, or after the final failed attempt. It receives the `err`
 * and `result` arguments of the last attempt at completing the `task`. Invoked
 * with (err, results).
 *
 * @example
 *
 * // The `retry` function can be used as a stand-alone control flow by passing
 * // a callback, as shown below:
 *
 * // try calling apiMethod 3 times
 * async.retry(3, apiMethod, function(err, result) {
 *     // do something with the result
 * });
 *
 * // try calling apiMethod 3 times, waiting 200 ms between each retry
 * async.retry({times: 3, interval: 200}, apiMethod, function(err, result) {
 *     // do something with the result
 * });
 *
 * // try calling apiMethod 10 times with exponential backoff
 * // (i.e. intervals of 100, 200, 400, 800, 1600, ... milliseconds)
 * async.retry({
 *   times: 10,
 *   interval: function(retryCount) {
 *     return 50 * Math.pow(2, retryCount);
 *   }
 * }, apiMethod, function(err, result) {
 *     // do something with the result
 * });
 *
 * // try calling apiMethod the default 5 times no delay between each retry
 * async.retry(apiMethod, function(err, result) {
 *     // do something with the result
 * });
 *
 * // try calling apiMethod only when error condition satisfies, all other
 * // errors will abort the retry control flow and return to final callback
 * async.retry({
 *   errorFilter: function(err) {
 *     return err.message === 'Temporary error'; // only retry on a specific error
 *   }
 * }, apiMethod, function(err, result) {
 *     // do something with the result
 * });
 *
 * // to retry individual methods that are not as reliable within other
 * // control flow functions, use the `retryable` wrapper:
 * async.auto({
 *     users: api.getUsers.bind(api),
 *     payments: async.retryable(3, api.getPayments.bind(api))
 * }, function(err, results) {
 *     // do something with the results
 * });
 *
 */
function retry(opts, task, callback) {
    var DEFAULT_TIMES = 5;
    var DEFAULT_INTERVAL = 0;

    var options = {
        times: DEFAULT_TIMES,
        intervalFunc: constant$1(DEFAULT_INTERVAL)
    };

    function parseTimes(acc, t) {
        if (typeof t === 'object') {
            acc.times = +t.times || DEFAULT_TIMES;

            acc.intervalFunc = typeof t.interval === 'function' ?
                t.interval :
                constant$1(+t.interval || DEFAULT_INTERVAL);

            acc.errorFilter = t.errorFilter;
        } else if (typeof t === 'number' || typeof t === 'string') {
            acc.times = +t || DEFAULT_TIMES;
        } else {
            throw new Error("Invalid arguments for async.retry");
        }
    }

    if (arguments.length < 3 && typeof opts === 'function') {
        callback = task || noop;
        task = opts;
    } else {
        parseTimes(options, opts);
        callback = callback || noop;
    }

    if (typeof task !== 'function') {
        throw new Error("Invalid arguments for async.retry");
    }

    var _task = wrapAsync(task);

    var attempt = 1;
    function retryAttempt() {
        _task(function(err) {
            if (err && attempt++ < options.times &&
                (typeof options.errorFilter != 'function' ||
                    options.errorFilter(err))) {
                setTimeout(retryAttempt, options.intervalFunc(attempt));
            } else {
                callback.apply(null, arguments);
            }
        });
    }

    retryAttempt();
}

/**
 * A close relative of [`retry`]{@link module:ControlFlow.retry}.  This method
 * wraps a task and makes it retryable, rather than immediately calling it
 * with retries.
 *
 * @name retryable
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.retry]{@link module:ControlFlow.retry}
 * @category Control Flow
 * @param {Object|number} [opts = {times: 5, interval: 0}| 5] - optional
 * options, exactly the same as from `retry`
 * @param {AsyncFunction} task - the asynchronous function to wrap.
 * This function will be passed any arguments passed to the returned wrapper.
 * Invoked with (...args, callback).
 * @returns {AsyncFunction} The wrapped function, which when invoked, will
 * retry on an error, based on the parameters specified in `opts`.
 * This function will accept the same parameters as `task`.
 * @example
 *
 * async.auto({
 *     dep1: async.retryable(3, getFromFlakyService),
 *     process: ["dep1", async.retryable(3, function (results, cb) {
 *         maybeProcessData(results.dep1, cb);
 *     })]
 * }, callback);
 */
var retryable = function (opts, task) {
    if (!task) {
        task = opts;
        opts = null;
    }
    var _task = wrapAsync(task);
    return initialParams(function (args, callback) {
        function taskFn(cb) {
            _task.apply(null, args.concat(cb));
        }

        if (opts) retry(opts, taskFn, callback);
        else retry(taskFn, callback);

    });
};

/**
 * Run the functions in the `tasks` collection in series, each one running once
 * the previous function has completed. If any functions in the series pass an
 * error to its callback, no more functions are run, and `callback` is
 * immediately called with the value of the error. Otherwise, `callback`
 * receives an array of results when `tasks` have completed.
 *
 * It is also possible to use an object instead of an array. Each property will
 * be run as a function, and the results will be passed to the final `callback`
 * as an object instead of an array. This can be a more readable way of handling
 *  results from {@link async.series}.
 *
 * **Note** that while many implementations preserve the order of object
 * properties, the [ECMAScript Language Specification](http://www.ecma-international.org/ecma-262/5.1/#sec-8.6)
 * explicitly states that
 *
 * > The mechanics and order of enumerating the properties is not specified.
 *
 * So if you rely on the order in which your series of functions are executed,
 * and want this to work on all platforms, consider using an array.
 *
 * @name series
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Array|Iterable|Object} tasks - A collection containing
 * [async functions]{@link AsyncFunction} to run in series.
 * Each function can complete with any number of optional `result` values.
 * @param {Function} [callback] - An optional callback to run once all the
 * functions have completed. This function gets a results array (or object)
 * containing all the result arguments passed to the `task` callbacks. Invoked
 * with (err, result).
 * @example
 * async.series([
 *     function(callback) {
 *         // do some stuff ...
 *         callback(null, 'one');
 *     },
 *     function(callback) {
 *         // do some more stuff ...
 *         callback(null, 'two');
 *     }
 * ],
 * // optional callback
 * function(err, results) {
 *     // results is now equal to ['one', 'two']
 * });
 *
 * async.series({
 *     one: function(callback) {
 *         setTimeout(function() {
 *             callback(null, 1);
 *         }, 200);
 *     },
 *     two: function(callback){
 *         setTimeout(function() {
 *             callback(null, 2);
 *         }, 100);
 *     }
 * }, function(err, results) {
 *     // results is now equal to: {one: 1, two: 2}
 * });
 */
function series(tasks, callback) {
    _parallel(eachOfSeries, tasks, callback);
}

/**
 * Returns `true` if at least one element in the `coll` satisfies an async test.
 * If any iteratee call returns `true`, the main `callback` is immediately
 * called.
 *
 * @name some
 * @static
 * @memberOf module:Collections
 * @method
 * @alias any
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async truth test to apply to each item
 * in the collections in parallel.
 * The iteratee should complete with a boolean `result` value.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called as soon as any
 * iteratee returns `true`, or after all the iteratee functions have finished.
 * Result will be either `true` or `false` depending on the values of the async
 * tests. Invoked with (err, result).
 * @example
 *
 * async.some(['file1','file2','file3'], function(filePath, callback) {
 *     fs.access(filePath, function(err) {
 *         callback(null, !err)
 *     });
 * }, function(err, result) {
 *     // if result is true then at least one of the files exists
 * });
 */
var some = doParallel(_createTester(Boolean, identity));

/**
 * The same as [`some`]{@link module:Collections.some} but runs a maximum of `limit` async operations at a time.
 *
 * @name someLimit
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.some]{@link module:Collections.some}
 * @alias anyLimit
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - An async truth test to apply to each item
 * in the collections in parallel.
 * The iteratee should complete with a boolean `result` value.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called as soon as any
 * iteratee returns `true`, or after all the iteratee functions have finished.
 * Result will be either `true` or `false` depending on the values of the async
 * tests. Invoked with (err, result).
 */
var someLimit = doParallelLimit(_createTester(Boolean, identity));

/**
 * The same as [`some`]{@link module:Collections.some} but runs only a single async operation at a time.
 *
 * @name someSeries
 * @static
 * @memberOf module:Collections
 * @method
 * @see [async.some]{@link module:Collections.some}
 * @alias anySeries
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async truth test to apply to each item
 * in the collections in series.
 * The iteratee should complete with a boolean `result` value.
 * Invoked with (item, callback).
 * @param {Function} [callback] - A callback which is called as soon as any
 * iteratee returns `true`, or after all the iteratee functions have finished.
 * Result will be either `true` or `false` depending on the values of the async
 * tests. Invoked with (err, result).
 */
var someSeries = doLimit(someLimit, 1);

/**
 * Sorts a list by the results of running each `coll` value through an async
 * `iteratee`.
 *
 * @name sortBy
 * @static
 * @memberOf module:Collections
 * @method
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {AsyncFunction} iteratee - An async function to apply to each item in
 * `coll`.
 * The iteratee should complete with a value to use as the sort criteria as
 * its `result`.
 * Invoked with (item, callback).
 * @param {Function} callback - A callback which is called after all the
 * `iteratee` functions have finished, or an error occurs. Results is the items
 * from the original `coll` sorted by the values returned by the `iteratee`
 * calls. Invoked with (err, results).
 * @example
 *
 * async.sortBy(['file1','file2','file3'], function(file, callback) {
 *     fs.stat(file, function(err, stats) {
 *         callback(err, stats.mtime);
 *     });
 * }, function(err, results) {
 *     // results is now the original array of files sorted by
 *     // modified date
 * });
 *
 * // By modifying the callback parameter the
 * // sorting order can be influenced:
 *
 * // ascending order
 * async.sortBy([1,9,3,5], function(x, callback) {
 *     callback(null, x);
 * }, function(err,result) {
 *     // result callback
 * });
 *
 * // descending order
 * async.sortBy([1,9,3,5], function(x, callback) {
 *     callback(null, x*-1);    //<- x*-1 instead of x, turns the order around
 * }, function(err,result) {
 *     // result callback
 * });
 */
function sortBy (coll, iteratee, callback) {
    var _iteratee = wrapAsync(iteratee);
    map(coll, function (x, callback) {
        _iteratee(x, function (err, criteria) {
            if (err) return callback(err);
            callback(null, {value: x, criteria: criteria});
        });
    }, function (err, results) {
        if (err) return callback(err);
        callback(null, arrayMap(results.sort(comparator), baseProperty('value')));
    });

    function comparator(left, right) {
        var a = left.criteria, b = right.criteria;
        return a < b ? -1 : a > b ? 1 : 0;
    }
}

/**
 * Sets a time limit on an asynchronous function. If the function does not call
 * its callback within the specified milliseconds, it will be called with a
 * timeout error. The code property for the error object will be `'ETIMEDOUT'`.
 *
 * @name timeout
 * @static
 * @memberOf module:Utils
 * @method
 * @category Util
 * @param {AsyncFunction} asyncFn - The async function to limit in time.
 * @param {number} milliseconds - The specified time limit.
 * @param {*} [info] - Any variable you want attached (`string`, `object`, etc)
 * to timeout Error for more information..
 * @returns {AsyncFunction} Returns a wrapped function that can be used with any
 * of the control flow functions.
 * Invoke this function with the same parameters as you would `asyncFunc`.
 * @example
 *
 * function myFunction(foo, callback) {
 *     doAsyncTask(foo, function(err, data) {
 *         // handle errors
 *         if (err) return callback(err);
 *
 *         // do some stuff ...
 *
 *         // return processed data
 *         return callback(null, data);
 *     });
 * }
 *
 * var wrapped = async.timeout(myFunction, 1000);
 *
 * // call `wrapped` as you would `myFunction`
 * wrapped({ bar: 'bar' }, function(err, data) {
 *     // if `myFunction` takes < 1000 ms to execute, `err`
 *     // and `data` will have their expected values
 *
 *     // else `err` will be an Error with the code 'ETIMEDOUT'
 * });
 */
function timeout(asyncFn, milliseconds, info) {
    var fn = wrapAsync(asyncFn);

    return initialParams(function (args, callback) {
        var timedOut = false;
        var timer;

        function timeoutCallback() {
            var name = asyncFn.name || 'anonymous';
            var error  = new Error('Callback function "' + name + '" timed out.');
            error.code = 'ETIMEDOUT';
            if (info) {
                error.info = info;
            }
            timedOut = true;
            callback(error);
        }

        args.push(function () {
            if (!timedOut) {
                callback.apply(null, arguments);
                clearTimeout(timer);
            }
        });

        // setup timer and call original function
        timer = setTimeout(timeoutCallback, milliseconds);
        fn.apply(null, args);
    });
}

/* Built-in method references for those with the same name as other `lodash` methods. */
var nativeCeil = Math.ceil;
var nativeMax = Math.max;

/**
 * The base implementation of `_.range` and `_.rangeRight` which doesn't
 * coerce arguments.
 *
 * @private
 * @param {number} start The start of the range.
 * @param {number} end The end of the range.
 * @param {number} step The value to increment or decrement by.
 * @param {boolean} [fromRight] Specify iterating from right to left.
 * @returns {Array} Returns the range of numbers.
 */
function baseRange(start, end, step, fromRight) {
  var index = -1,
      length = nativeMax(nativeCeil((end - start) / (step || 1)), 0),
      result = Array(length);

  while (length--) {
    result[fromRight ? length : ++index] = start;
    start += step;
  }
  return result;
}

/**
 * The same as [times]{@link module:ControlFlow.times} but runs a maximum of `limit` async operations at a
 * time.
 *
 * @name timesLimit
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.times]{@link module:ControlFlow.times}
 * @category Control Flow
 * @param {number} count - The number of times to run the function.
 * @param {number} limit - The maximum number of async operations at a time.
 * @param {AsyncFunction} iteratee - The async function to call `n` times.
 * Invoked with the iteration index and a callback: (n, next).
 * @param {Function} callback - see [async.map]{@link module:Collections.map}.
 */
function timeLimit(count, limit, iteratee, callback) {
    var _iteratee = wrapAsync(iteratee);
    mapLimit(baseRange(0, count, 1), limit, _iteratee, callback);
}

/**
 * Calls the `iteratee` function `n` times, and accumulates results in the same
 * manner you would use with [map]{@link module:Collections.map}.
 *
 * @name times
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.map]{@link module:Collections.map}
 * @category Control Flow
 * @param {number} n - The number of times to run the function.
 * @param {AsyncFunction} iteratee - The async function to call `n` times.
 * Invoked with the iteration index and a callback: (n, next).
 * @param {Function} callback - see {@link module:Collections.map}.
 * @example
 *
 * // Pretend this is some complicated async factory
 * var createUser = function(id, callback) {
 *     callback(null, {
 *         id: 'user' + id
 *     });
 * };
 *
 * // generate 5 users
 * async.times(5, function(n, next) {
 *     createUser(n, function(err, user) {
 *         next(err, user);
 *     });
 * }, function(err, users) {
 *     // we should now have 5 users
 * });
 */
var times = doLimit(timeLimit, Infinity);

/**
 * The same as [times]{@link module:ControlFlow.times} but runs only a single async operation at a time.
 *
 * @name timesSeries
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.times]{@link module:ControlFlow.times}
 * @category Control Flow
 * @param {number} n - The number of times to run the function.
 * @param {AsyncFunction} iteratee - The async function to call `n` times.
 * Invoked with the iteration index and a callback: (n, next).
 * @param {Function} callback - see {@link module:Collections.map}.
 */
var timesSeries = doLimit(timeLimit, 1);

/**
 * A relative of `reduce`.  Takes an Object or Array, and iterates over each
 * element in series, each step potentially mutating an `accumulator` value.
 * The type of the accumulator defaults to the type of collection passed in.
 *
 * @name transform
 * @static
 * @memberOf module:Collections
 * @method
 * @category Collection
 * @param {Array|Iterable|Object} coll - A collection to iterate over.
 * @param {*} [accumulator] - The initial state of the transform.  If omitted,
 * it will default to an empty Object or Array, depending on the type of `coll`
 * @param {AsyncFunction} iteratee - A function applied to each item in the
 * collection that potentially modifies the accumulator.
 * Invoked with (accumulator, item, key, callback).
 * @param {Function} [callback] - A callback which is called after all the
 * `iteratee` functions have finished. Result is the transformed accumulator.
 * Invoked with (err, result).
 * @example
 *
 * async.transform([1,2,3], function(acc, item, index, callback) {
 *     // pointless async:
 *     process.nextTick(function() {
 *         acc.push(item * 2)
 *         callback(null)
 *     });
 * }, function(err, result) {
 *     // result is now equal to [2, 4, 6]
 * });
 *
 * @example
 *
 * async.transform({a: 1, b: 2, c: 3}, function (obj, val, key, callback) {
 *     setImmediate(function () {
 *         obj[key] = val * 2;
 *         callback();
 *     })
 * }, function (err, result) {
 *     // result is equal to {a: 2, b: 4, c: 6}
 * })
 */
function transform (coll, accumulator, iteratee, callback) {
    if (arguments.length <= 3) {
        callback = iteratee;
        iteratee = accumulator;
        accumulator = isArray(coll) ? [] : {};
    }
    callback = once(callback || noop);
    var _iteratee = wrapAsync(iteratee);

    eachOf(coll, function(v, k, cb) {
        _iteratee(accumulator, v, k, cb);
    }, function(err) {
        callback(err, accumulator);
    });
}

/**
 * It runs each task in series but stops whenever any of the functions were
 * successful. If one of the tasks were successful, the `callback` will be
 * passed the result of the successful task. If all tasks fail, the callback
 * will be passed the error and result (if any) of the final attempt.
 *
 * @name tryEach
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Array|Iterable|Object} tasks - A collection containing functions to
 * run, each function is passed a `callback(err, result)` it must call on
 * completion with an error `err` (which can be `null`) and an optional `result`
 * value.
 * @param {Function} [callback] - An optional callback which is called when one
 * of the tasks has succeeded, or all have failed. It receives the `err` and
 * `result` arguments of the last attempt at completing the `task`. Invoked with
 * (err, results).
 * @example
 * async.tryEach([
 *     function getDataFromFirstWebsite(callback) {
 *         // Try getting the data from the first website
 *         callback(err, data);
 *     },
 *     function getDataFromSecondWebsite(callback) {
 *         // First website failed,
 *         // Try getting the data from the backup website
 *         callback(err, data);
 *     }
 * ],
 * // optional callback
 * function(err, results) {
 *     Now do something with the data.
 * });
 *
 */
function tryEach(tasks, callback) {
    var error = null;
    var result;
    callback = callback || noop;
    eachSeries(tasks, function(task, callback) {
        wrapAsync(task)(function (err, res/*, ...args*/) {
            if (arguments.length > 2) {
                result = slice(arguments, 1);
            } else {
                result = res;
            }
            error = err;
            callback(!err);
        });
    }, function () {
        callback(error, result);
    });
}

/**
 * Undoes a [memoize]{@link module:Utils.memoize}d function, reverting it to the original,
 * unmemoized form. Handy for testing.
 *
 * @name unmemoize
 * @static
 * @memberOf module:Utils
 * @method
 * @see [async.memoize]{@link module:Utils.memoize}
 * @category Util
 * @param {AsyncFunction} fn - the memoized function
 * @returns {AsyncFunction} a function that calls the original unmemoized function
 */
function unmemoize(fn) {
    return function () {
        return (fn.unmemoized || fn).apply(null, arguments);
    };
}

/**
 * Repeatedly call `iteratee`, while `test` returns `true`. Calls `callback` when
 * stopped, or an error occurs.
 *
 * @name whilst
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Function} test - synchronous truth test to perform before each
 * execution of `iteratee`. Invoked with ().
 * @param {AsyncFunction} iteratee - An async function which is called each time
 * `test` passes. Invoked with (callback).
 * @param {Function} [callback] - A callback which is called after the test
 * function has failed and repeated execution of `iteratee` has stopped. `callback`
 * will be passed an error and any arguments passed to the final `iteratee`'s
 * callback. Invoked with (err, [results]);
 * @returns undefined
 * @example
 *
 * var count = 0;
 * async.whilst(
 *     function() { return count < 5; },
 *     function(callback) {
 *         count++;
 *         setTimeout(function() {
 *             callback(null, count);
 *         }, 1000);
 *     },
 *     function (err, n) {
 *         // 5 seconds have passed, n = 5
 *     }
 * );
 */
function whilst(test, iteratee, callback) {
    callback = onlyOnce(callback || noop);
    var _iteratee = wrapAsync(iteratee);
    if (!test()) return callback(null);
    var next = function(err/*, ...args*/) {
        if (err) return callback(err);
        if (test()) return _iteratee(next);
        var args = slice(arguments, 1);
        callback.apply(null, [null].concat(args));
    };
    _iteratee(next);
}

/**
 * Repeatedly call `iteratee` until `test` returns `true`. Calls `callback` when
 * stopped, or an error occurs. `callback` will be passed an error and any
 * arguments passed to the final `iteratee`'s callback.
 *
 * The inverse of [whilst]{@link module:ControlFlow.whilst}.
 *
 * @name until
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @see [async.whilst]{@link module:ControlFlow.whilst}
 * @category Control Flow
 * @param {Function} test - synchronous truth test to perform before each
 * execution of `iteratee`. Invoked with ().
 * @param {AsyncFunction} iteratee - An async function which is called each time
 * `test` fails. Invoked with (callback).
 * @param {Function} [callback] - A callback which is called after the test
 * function has passed and repeated execution of `iteratee` has stopped. `callback`
 * will be passed an error and any arguments passed to the final `iteratee`'s
 * callback. Invoked with (err, [results]);
 */
function until(test, iteratee, callback) {
    whilst(function() {
        return !test.apply(this, arguments);
    }, iteratee, callback);
}

/**
 * Runs the `tasks` array of functions in series, each passing their results to
 * the next in the array. However, if any of the `tasks` pass an error to their
 * own callback, the next function is not executed, and the main `callback` is
 * immediately called with the error.
 *
 * @name waterfall
 * @static
 * @memberOf module:ControlFlow
 * @method
 * @category Control Flow
 * @param {Array} tasks - An array of [async functions]{@link AsyncFunction}
 * to run.
 * Each function should complete with any number of `result` values.
 * The `result` values will be passed as arguments, in order, to the next task.
 * @param {Function} [callback] - An optional callback to run once all the
 * functions have completed. This will be passed the results of the last task's
 * callback. Invoked with (err, [results]).
 * @returns undefined
 * @example
 *
 * async.waterfall([
 *     function(callback) {
 *         callback(null, 'one', 'two');
 *     },
 *     function(arg1, arg2, callback) {
 *         // arg1 now equals 'one' and arg2 now equals 'two'
 *         callback(null, 'three');
 *     },
 *     function(arg1, callback) {
 *         // arg1 now equals 'three'
 *         callback(null, 'done');
 *     }
 * ], function (err, result) {
 *     // result now equals 'done'
 * });
 *
 * // Or, with named functions:
 * async.waterfall([
 *     myFirstFunction,
 *     mySecondFunction,
 *     myLastFunction,
 * ], function (err, result) {
 *     // result now equals 'done'
 * });
 * function myFirstFunction(callback) {
 *     callback(null, 'one', 'two');
 * }
 * function mySecondFunction(arg1, arg2, callback) {
 *     // arg1 now equals 'one' and arg2 now equals 'two'
 *     callback(null, 'three');
 * }
 * function myLastFunction(arg1, callback) {
 *     // arg1 now equals 'three'
 *     callback(null, 'done');
 * }
 */
var waterfall = function(tasks, callback) {
    callback = once(callback || noop);
    if (!isArray(tasks)) return callback(new Error('First argument to waterfall must be an array of functions'));
    if (!tasks.length) return callback();
    var taskIndex = 0;

    function nextTask(args) {
        var task = wrapAsync(tasks[taskIndex++]);
        args.push(onlyOnce(next));
        task.apply(null, args);
    }

    function next(err/*, ...args*/) {
        if (err || taskIndex === tasks.length) {
            return callback.apply(null, arguments);
        }
        nextTask(slice(arguments, 1));
    }

    nextTask([]);
};

/**
 * An "async function" in the context of Async is an asynchronous function with
 * a variable number of parameters, with the final parameter being a callback.
 * (`function (arg1, arg2, ..., callback) {}`)
 * The final callback is of the form `callback(err, results...)`, which must be
 * called once the function is completed.  The callback should be called with a
 * Error as its first argument to signal that an error occurred.
 * Otherwise, if no error occurred, it should be called with `null` as the first
 * argument, and any additional `result` arguments that may apply, to signal
 * successful completion.
 * The callback must be called exactly once, ideally on a later tick of the
 * JavaScript event loop.
 *
 * This type of function is also referred to as a "Node-style async function",
 * or a "continuation passing-style function" (CPS). Most of the methods of this
 * library are themselves CPS/Node-style async functions, or functions that
 * return CPS/Node-style async functions.
 *
 * Wherever we accept a Node-style async function, we also directly accept an
 * [ES2017 `async` function]{@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function}.
 * In this case, the `async` function will not be passed a final callback
 * argument, and any thrown error will be used as the `err` argument of the
 * implicit callback, and the return value will be used as the `result` value.
 * (i.e. a `rejected` of the returned Promise becomes the `err` callback
 * argument, and a `resolved` value becomes the `result`.)
 *
 * Note, due to JavaScript limitations, we can only detect native `async`
 * functions and not transpilied implementations.
 * Your environment must have `async`/`await` support for this to work.
 * (e.g. Node > v7.6, or a recent version of a modern browser).
 * If you are using `async` functions through a transpiler (e.g. Babel), you
 * must still wrap the function with [asyncify]{@link module:Utils.asyncify},
 * because the `async function` will be compiled to an ordinary function that
 * returns a promise.
 *
 * @typedef {Function} AsyncFunction
 * @static
 */

/**
 * Async is a utility module which provides straight-forward, powerful functions
 * for working with asynchronous JavaScript. Although originally designed for
 * use with [Node.js](http://nodejs.org) and installable via
 * `npm install --save async`, it can also be used directly in the browser.
 * @module async
 * @see AsyncFunction
 */


/**
 * A collection of `async` functions for manipulating collections, such as
 * arrays and objects.
 * @module Collections
 */

/**
 * A collection of `async` functions for controlling the flow through a script.
 * @module ControlFlow
 */

/**
 * A collection of `async` utility functions.
 * @module Utils
 */

var index = {
    apply: apply,
    applyEach: applyEach,
    applyEachSeries: applyEachSeries,
    asyncify: asyncify,
    auto: auto,
    autoInject: autoInject,
    cargo: cargo,
    compose: compose,
    concat: concat,
    concatLimit: concatLimit,
    concatSeries: concatSeries,
    constant: constant,
    detect: detect,
    detectLimit: detectLimit,
    detectSeries: detectSeries,
    dir: dir,
    doDuring: doDuring,
    doUntil: doUntil,
    doWhilst: doWhilst,
    during: during,
    each: eachLimit,
    eachLimit: eachLimit$1,
    eachOf: eachOf,
    eachOfLimit: eachOfLimit,
    eachOfSeries: eachOfSeries,
    eachSeries: eachSeries,
    ensureAsync: ensureAsync,
    every: every,
    everyLimit: everyLimit,
    everySeries: everySeries,
    filter: filter,
    filterLimit: filterLimit,
    filterSeries: filterSeries,
    forever: forever,
    groupBy: groupBy,
    groupByLimit: groupByLimit,
    groupBySeries: groupBySeries,
    log: log,
    map: map,
    mapLimit: mapLimit,
    mapSeries: mapSeries,
    mapValues: mapValues,
    mapValuesLimit: mapValuesLimit,
    mapValuesSeries: mapValuesSeries,
    memoize: memoize,
    nextTick: nextTick,
    parallel: parallelLimit,
    parallelLimit: parallelLimit$1,
    priorityQueue: priorityQueue,
    queue: queue$1,
    race: race,
    reduce: reduce,
    reduceRight: reduceRight,
    reflect: reflect,
    reflectAll: reflectAll,
    reject: reject,
    rejectLimit: rejectLimit,
    rejectSeries: rejectSeries,
    retry: retry,
    retryable: retryable,
    seq: seq,
    series: series,
    setImmediate: setImmediate$1,
    some: some,
    someLimit: someLimit,
    someSeries: someSeries,
    sortBy: sortBy,
    timeout: timeout,
    times: times,
    timesLimit: timeLimit,
    timesSeries: timesSeries,
    transform: transform,
    tryEach: tryEach,
    unmemoize: unmemoize,
    until: until,
    waterfall: waterfall,
    whilst: whilst,

    // aliases
    all: every,
    allLimit: everyLimit,
    allSeries: everySeries,
    any: some,
    anyLimit: someLimit,
    anySeries: someSeries,
    find: detect,
    findLimit: detectLimit,
    findSeries: detectSeries,
    forEach: eachLimit,
    forEachSeries: eachSeries,
    forEachLimit: eachLimit$1,
    forEachOf: eachOf,
    forEachOfSeries: eachOfSeries,
    forEachOfLimit: eachOfLimit,
    inject: reduce,
    foldl: reduce,
    foldr: reduceRight,
    select: filter,
    selectLimit: filterLimit,
    selectSeries: filterSeries,
    wrapSync: asyncify
};

exports['default'] = index;
exports.apply = apply;
exports.applyEach = applyEach;
exports.applyEachSeries = applyEachSeries;
exports.asyncify = asyncify;
exports.auto = auto;
exports.autoInject = autoInject;
exports.cargo = cargo;
exports.compose = compose;
exports.concat = concat;
exports.concatLimit = concatLimit;
exports.concatSeries = concatSeries;
exports.constant = constant;
exports.detect = detect;
exports.detectLimit = detectLimit;
exports.detectSeries = detectSeries;
exports.dir = dir;
exports.doDuring = doDuring;
exports.doUntil = doUntil;
exports.doWhilst = doWhilst;
exports.during = during;
exports.each = eachLimit;
exports.eachLimit = eachLimit$1;
exports.eachOf = eachOf;
exports.eachOfLimit = eachOfLimit;
exports.eachOfSeries = eachOfSeries;
exports.eachSeries = eachSeries;
exports.ensureAsync = ensureAsync;
exports.every = every;
exports.everyLimit = everyLimit;
exports.everySeries = everySeries;
exports.filter = filter;
exports.filterLimit = filterLimit;
exports.filterSeries = filterSeries;
exports.forever = forever;
exports.groupBy = groupBy;
exports.groupByLimit = groupByLimit;
exports.groupBySeries = groupBySeries;
exports.log = log;
exports.map = map;
exports.mapLimit = mapLimit;
exports.mapSeries = mapSeries;
exports.mapValues = mapValues;
exports.mapValuesLimit = mapValuesLimit;
exports.mapValuesSeries = mapValuesSeries;
exports.memoize = memoize;
exports.nextTick = nextTick;
exports.parallel = parallelLimit;
exports.parallelLimit = parallelLimit$1;
exports.priorityQueue = priorityQueue;
exports.queue = queue$1;
exports.race = race;
exports.reduce = reduce;
exports.reduceRight = reduceRight;
exports.reflect = reflect;
exports.reflectAll = reflectAll;
exports.reject = reject;
exports.rejectLimit = rejectLimit;
exports.rejectSeries = rejectSeries;
exports.retry = retry;
exports.retryable = retryable;
exports.seq = seq;
exports.series = series;
exports.setImmediate = setImmediate$1;
exports.some = some;
exports.someLimit = someLimit;
exports.someSeries = someSeries;
exports.sortBy = sortBy;
exports.timeout = timeout;
exports.times = times;
exports.timesLimit = timeLimit;
exports.timesSeries = timesSeries;
exports.transform = transform;
exports.tryEach = tryEach;
exports.unmemoize = unmemoize;
exports.until = until;
exports.waterfall = waterfall;
exports.whilst = whilst;
exports.all = every;
exports.allLimit = everyLimit;
exports.allSeries = everySeries;
exports.any = some;
exports.anyLimit = someLimit;
exports.anySeries = someSeries;
exports.find = detect;
exports.findLimit = detectLimit;
exports.findSeries = detectSeries;
exports.forEach = eachLimit;
exports.forEachSeries = eachSeries;
exports.forEachLimit = eachLimit$1;
exports.forEachOf = eachOf;
exports.forEachOfSeries = eachOfSeries;
exports.forEachOfLimit = eachOfLimit;
exports.inject = reduce;
exports.foldl = reduce;
exports.foldr = reduceRight;
exports.select = filter;
exports.selectLimit = filterLimit;
exports.selectSeries = filterSeries;
exports.wrapSync = asyncify;

Object.defineProperty(exports, '__esModule', { value: true });

})));

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("timers").setImmediate)
},{"_process":122,"timers":146}],"es6-promise":[function(require,module,exports){
(function (process,global){
/*!
 * @overview es6-promise - a tiny implementation of Promises/A+.
 * @copyright Copyright (c) 2014 Yehuda Katz, Tom Dale, Stefan Penner and contributors (Conversion to ES6 API by Jake Archibald)
 * @license   Licensed under MIT license
 *            See https://raw.githubusercontent.com/stefanpenner/es6-promise/master/LICENSE
 * @version   v4.2.8+1e68dce6
 */

(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
	typeof define === 'function' && define.amd ? define(factory) :
	(global.ES6Promise = factory());
}(this, (function () { 'use strict';

function objectOrFunction(x) {
  var type = typeof x;
  return x !== null && (type === 'object' || type === 'function');
}

function isFunction(x) {
  return typeof x === 'function';
}



var _isArray = void 0;
if (Array.isArray) {
  _isArray = Array.isArray;
} else {
  _isArray = function (x) {
    return Object.prototype.toString.call(x) === '[object Array]';
  };
}

var isArray = _isArray;

var len = 0;
var vertxNext = void 0;
var customSchedulerFn = void 0;

var asap = function asap(callback, arg) {
  queue[len] = callback;
  queue[len + 1] = arg;
  len += 2;
  if (len === 2) {
    // If len is 2, that means that we need to schedule an async flush.
    // If additional callbacks are queued before the queue is flushed, they
    // will be processed by this flush that we are scheduling.
    if (customSchedulerFn) {
      customSchedulerFn(flush);
    } else {
      scheduleFlush();
    }
  }
};

function setScheduler(scheduleFn) {
  customSchedulerFn = scheduleFn;
}

function setAsap(asapFn) {
  asap = asapFn;
}

var browserWindow = typeof window !== 'undefined' ? window : undefined;
var browserGlobal = browserWindow || {};
var BrowserMutationObserver = browserGlobal.MutationObserver || browserGlobal.WebKitMutationObserver;
var isNode = typeof self === 'undefined' && typeof process !== 'undefined' && {}.toString.call(process) === '[object process]';

// test for web worker but not in IE10
var isWorker = typeof Uint8ClampedArray !== 'undefined' && typeof importScripts !== 'undefined' && typeof MessageChannel !== 'undefined';

// node
function useNextTick() {
  // node version 0.10.x displays a deprecation warning when nextTick is used recursively
  // see https://github.com/cujojs/when/issues/410 for details
  return function () {
    return process.nextTick(flush);
  };
}

// vertx
function useVertxTimer() {
  if (typeof vertxNext !== 'undefined') {
    return function () {
      vertxNext(flush);
    };
  }

  return useSetTimeout();
}

function useMutationObserver() {
  var iterations = 0;
  var observer = new BrowserMutationObserver(flush);
  var node = document.createTextNode('');
  observer.observe(node, { characterData: true });

  return function () {
    node.data = iterations = ++iterations % 2;
  };
}

// web worker
function useMessageChannel() {
  var channel = new MessageChannel();
  channel.port1.onmessage = flush;
  return function () {
    return channel.port2.postMessage(0);
  };
}

function useSetTimeout() {
  // Store setTimeout reference so es6-promise will be unaffected by
  // other code modifying setTimeout (like sinon.useFakeTimers())
  var globalSetTimeout = setTimeout;
  return function () {
    return globalSetTimeout(flush, 1);
  };
}

var queue = new Array(1000);
function flush() {
  for (var i = 0; i < len; i += 2) {
    var callback = queue[i];
    var arg = queue[i + 1];

    callback(arg);

    queue[i] = undefined;
    queue[i + 1] = undefined;
  }

  len = 0;
}

function attemptVertx() {
  try {
    var vertx = Function('return this')().require('vertx');
    vertxNext = vertx.runOnLoop || vertx.runOnContext;
    return useVertxTimer();
  } catch (e) {
    return useSetTimeout();
  }
}

var scheduleFlush = void 0;
// Decide what async method to use to triggering processing of queued callbacks:
if (isNode) {
  scheduleFlush = useNextTick();
} else if (BrowserMutationObserver) {
  scheduleFlush = useMutationObserver();
} else if (isWorker) {
  scheduleFlush = useMessageChannel();
} else if (browserWindow === undefined && typeof require === 'function') {
  scheduleFlush = attemptVertx();
} else {
  scheduleFlush = useSetTimeout();
}

function then(onFulfillment, onRejection) {
  var parent = this;

  var child = new this.constructor(noop);

  if (child[PROMISE_ID] === undefined) {
    makePromise(child);
  }

  var _state = parent._state;


  if (_state) {
    var callback = arguments[_state - 1];
    asap(function () {
      return invokeCallback(_state, child, callback, parent._result);
    });
  } else {
    subscribe(parent, child, onFulfillment, onRejection);
  }

  return child;
}

/**
  `Promise.resolve` returns a promise that will become resolved with the
  passed `value`. It is shorthand for the following:

  ```javascript
  let promise = new Promise(function(resolve, reject){
    resolve(1);
  });

  promise.then(function(value){
    // value === 1
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  let promise = Promise.resolve(1);

  promise.then(function(value){
    // value === 1
  });
  ```

  @method resolve
  @static
  @param {Any} value value that the returned promise will be resolved with
  Useful for tooling.
  @return {Promise} a promise that will become fulfilled with the given
  `value`
*/
function resolve$1(object) {
  /*jshint validthis:true */
  var Constructor = this;

  if (object && typeof object === 'object' && object.constructor === Constructor) {
    return object;
  }

  var promise = new Constructor(noop);
  resolve(promise, object);
  return promise;
}

var PROMISE_ID = Math.random().toString(36).substring(2);

function noop() {}

var PENDING = void 0;
var FULFILLED = 1;
var REJECTED = 2;

function selfFulfillment() {
  return new TypeError("You cannot resolve a promise with itself");
}

function cannotReturnOwn() {
  return new TypeError('A promises callback cannot return that same promise.');
}

function tryThen(then$$1, value, fulfillmentHandler, rejectionHandler) {
  try {
    then$$1.call(value, fulfillmentHandler, rejectionHandler);
  } catch (e) {
    return e;
  }
}

function handleForeignThenable(promise, thenable, then$$1) {
  asap(function (promise) {
    var sealed = false;
    var error = tryThen(then$$1, thenable, function (value) {
      if (sealed) {
        return;
      }
      sealed = true;
      if (thenable !== value) {
        resolve(promise, value);
      } else {
        fulfill(promise, value);
      }
    }, function (reason) {
      if (sealed) {
        return;
      }
      sealed = true;

      reject(promise, reason);
    }, 'Settle: ' + (promise._label || ' unknown promise'));

    if (!sealed && error) {
      sealed = true;
      reject(promise, error);
    }
  }, promise);
}

function handleOwnThenable(promise, thenable) {
  if (thenable._state === FULFILLED) {
    fulfill(promise, thenable._result);
  } else if (thenable._state === REJECTED) {
    reject(promise, thenable._result);
  } else {
    subscribe(thenable, undefined, function (value) {
      return resolve(promise, value);
    }, function (reason) {
      return reject(promise, reason);
    });
  }
}

function handleMaybeThenable(promise, maybeThenable, then$$1) {
  if (maybeThenable.constructor === promise.constructor && then$$1 === then && maybeThenable.constructor.resolve === resolve$1) {
    handleOwnThenable(promise, maybeThenable);
  } else {
    if (then$$1 === undefined) {
      fulfill(promise, maybeThenable);
    } else if (isFunction(then$$1)) {
      handleForeignThenable(promise, maybeThenable, then$$1);
    } else {
      fulfill(promise, maybeThenable);
    }
  }
}

function resolve(promise, value) {
  if (promise === value) {
    reject(promise, selfFulfillment());
  } else if (objectOrFunction(value)) {
    var then$$1 = void 0;
    try {
      then$$1 = value.then;
    } catch (error) {
      reject(promise, error);
      return;
    }
    handleMaybeThenable(promise, value, then$$1);
  } else {
    fulfill(promise, value);
  }
}

function publishRejection(promise) {
  if (promise._onerror) {
    promise._onerror(promise._result);
  }

  publish(promise);
}

function fulfill(promise, value) {
  if (promise._state !== PENDING) {
    return;
  }

  promise._result = value;
  promise._state = FULFILLED;

  if (promise._subscribers.length !== 0) {
    asap(publish, promise);
  }
}

function reject(promise, reason) {
  if (promise._state !== PENDING) {
    return;
  }
  promise._state = REJECTED;
  promise._result = reason;

  asap(publishRejection, promise);
}

function subscribe(parent, child, onFulfillment, onRejection) {
  var _subscribers = parent._subscribers;
  var length = _subscribers.length;


  parent._onerror = null;

  _subscribers[length] = child;
  _subscribers[length + FULFILLED] = onFulfillment;
  _subscribers[length + REJECTED] = onRejection;

  if (length === 0 && parent._state) {
    asap(publish, parent);
  }
}

function publish(promise) {
  var subscribers = promise._subscribers;
  var settled = promise._state;

  if (subscribers.length === 0) {
    return;
  }

  var child = void 0,
      callback = void 0,
      detail = promise._result;

  for (var i = 0; i < subscribers.length; i += 3) {
    child = subscribers[i];
    callback = subscribers[i + settled];

    if (child) {
      invokeCallback(settled, child, callback, detail);
    } else {
      callback(detail);
    }
  }

  promise._subscribers.length = 0;
}

function invokeCallback(settled, promise, callback, detail) {
  var hasCallback = isFunction(callback),
      value = void 0,
      error = void 0,
      succeeded = true;

  if (hasCallback) {
    try {
      value = callback(detail);
    } catch (e) {
      succeeded = false;
      error = e;
    }

    if (promise === value) {
      reject(promise, cannotReturnOwn());
      return;
    }
  } else {
    value = detail;
  }

  if (promise._state !== PENDING) {
    // noop
  } else if (hasCallback && succeeded) {
    resolve(promise, value);
  } else if (succeeded === false) {
    reject(promise, error);
  } else if (settled === FULFILLED) {
    fulfill(promise, value);
  } else if (settled === REJECTED) {
    reject(promise, value);
  }
}

function initializePromise(promise, resolver) {
  try {
    resolver(function resolvePromise(value) {
      resolve(promise, value);
    }, function rejectPromise(reason) {
      reject(promise, reason);
    });
  } catch (e) {
    reject(promise, e);
  }
}

var id = 0;
function nextId() {
  return id++;
}

function makePromise(promise) {
  promise[PROMISE_ID] = id++;
  promise._state = undefined;
  promise._result = undefined;
  promise._subscribers = [];
}

function validationError() {
  return new Error('Array Methods must be provided an Array');
}

var Enumerator = function () {
  function Enumerator(Constructor, input) {
    this._instanceConstructor = Constructor;
    this.promise = new Constructor(noop);

    if (!this.promise[PROMISE_ID]) {
      makePromise(this.promise);
    }

    if (isArray(input)) {
      this.length = input.length;
      this._remaining = input.length;

      this._result = new Array(this.length);

      if (this.length === 0) {
        fulfill(this.promise, this._result);
      } else {
        this.length = this.length || 0;
        this._enumerate(input);
        if (this._remaining === 0) {
          fulfill(this.promise, this._result);
        }
      }
    } else {
      reject(this.promise, validationError());
    }
  }

  Enumerator.prototype._enumerate = function _enumerate(input) {
    for (var i = 0; this._state === PENDING && i < input.length; i++) {
      this._eachEntry(input[i], i);
    }
  };

  Enumerator.prototype._eachEntry = function _eachEntry(entry, i) {
    var c = this._instanceConstructor;
    var resolve$$1 = c.resolve;


    if (resolve$$1 === resolve$1) {
      var _then = void 0;
      var error = void 0;
      var didError = false;
      try {
        _then = entry.then;
      } catch (e) {
        didError = true;
        error = e;
      }

      if (_then === then && entry._state !== PENDING) {
        this._settledAt(entry._state, i, entry._result);
      } else if (typeof _then !== 'function') {
        this._remaining--;
        this._result[i] = entry;
      } else if (c === Promise$1) {
        var promise = new c(noop);
        if (didError) {
          reject(promise, error);
        } else {
          handleMaybeThenable(promise, entry, _then);
        }
        this._willSettleAt(promise, i);
      } else {
        this._willSettleAt(new c(function (resolve$$1) {
          return resolve$$1(entry);
        }), i);
      }
    } else {
      this._willSettleAt(resolve$$1(entry), i);
    }
  };

  Enumerator.prototype._settledAt = function _settledAt(state, i, value) {
    var promise = this.promise;


    if (promise._state === PENDING) {
      this._remaining--;

      if (state === REJECTED) {
        reject(promise, value);
      } else {
        this._result[i] = value;
      }
    }

    if (this._remaining === 0) {
      fulfill(promise, this._result);
    }
  };

  Enumerator.prototype._willSettleAt = function _willSettleAt(promise, i) {
    var enumerator = this;

    subscribe(promise, undefined, function (value) {
      return enumerator._settledAt(FULFILLED, i, value);
    }, function (reason) {
      return enumerator._settledAt(REJECTED, i, reason);
    });
  };

  return Enumerator;
}();

/**
  `Promise.all` accepts an array of promises, and returns a new promise which
  is fulfilled with an array of fulfillment values for the passed promises, or
  rejected with the reason of the first passed promise to be rejected. It casts all
  elements of the passed iterable to promises as it runs this algorithm.

  Example:

  ```javascript
  let promise1 = resolve(1);
  let promise2 = resolve(2);
  let promise3 = resolve(3);
  let promises = [ promise1, promise2, promise3 ];

  Promise.all(promises).then(function(array){
    // The array here would be [ 1, 2, 3 ];
  });
  ```

  If any of the `promises` given to `all` are rejected, the first promise
  that is rejected will be given as an argument to the returned promises's
  rejection handler. For example:

  Example:

  ```javascript
  let promise1 = resolve(1);
  let promise2 = reject(new Error("2"));
  let promise3 = reject(new Error("3"));
  let promises = [ promise1, promise2, promise3 ];

  Promise.all(promises).then(function(array){
    // Code here never runs because there are rejected promises!
  }, function(error) {
    // error.message === "2"
  });
  ```

  @method all
  @static
  @param {Array} entries array of promises
  @param {String} label optional string for labeling the promise.
  Useful for tooling.
  @return {Promise} promise that is fulfilled when all `promises` have been
  fulfilled, or rejected if any of them become rejected.
  @static
*/
function all(entries) {
  return new Enumerator(this, entries).promise;
}

/**
  `Promise.race` returns a new promise which is settled in the same way as the
  first passed promise to settle.

  Example:

  ```javascript
  let promise1 = new Promise(function(resolve, reject){
    setTimeout(function(){
      resolve('promise 1');
    }, 200);
  });

  let promise2 = new Promise(function(resolve, reject){
    setTimeout(function(){
      resolve('promise 2');
    }, 100);
  });

  Promise.race([promise1, promise2]).then(function(result){
    // result === 'promise 2' because it was resolved before promise1
    // was resolved.
  });
  ```

  `Promise.race` is deterministic in that only the state of the first
  settled promise matters. For example, even if other promises given to the
  `promises` array argument are resolved, but the first settled promise has
  become rejected before the other promises became fulfilled, the returned
  promise will become rejected:

  ```javascript
  let promise1 = new Promise(function(resolve, reject){
    setTimeout(function(){
      resolve('promise 1');
    }, 200);
  });

  let promise2 = new Promise(function(resolve, reject){
    setTimeout(function(){
      reject(new Error('promise 2'));
    }, 100);
  });

  Promise.race([promise1, promise2]).then(function(result){
    // Code here never runs
  }, function(reason){
    // reason.message === 'promise 2' because promise 2 became rejected before
    // promise 1 became fulfilled
  });
  ```

  An example real-world use case is implementing timeouts:

  ```javascript
  Promise.race([ajax('foo.json'), timeout(5000)])
  ```

  @method race
  @static
  @param {Array} promises array of promises to observe
  Useful for tooling.
  @return {Promise} a promise which settles in the same way as the first passed
  promise to settle.
*/
function race(entries) {
  /*jshint validthis:true */
  var Constructor = this;

  if (!isArray(entries)) {
    return new Constructor(function (_, reject) {
      return reject(new TypeError('You must pass an array to race.'));
    });
  } else {
    return new Constructor(function (resolve, reject) {
      var length = entries.length;
      for (var i = 0; i < length; i++) {
        Constructor.resolve(entries[i]).then(resolve, reject);
      }
    });
  }
}

/**
  `Promise.reject` returns a promise rejected with the passed `reason`.
  It is shorthand for the following:

  ```javascript
  let promise = new Promise(function(resolve, reject){
    reject(new Error('WHOOPS'));
  });

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  let promise = Promise.reject(new Error('WHOOPS'));

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  @method reject
  @static
  @param {Any} reason value that the returned promise will be rejected with.
  Useful for tooling.
  @return {Promise} a promise rejected with the given `reason`.
*/
function reject$1(reason) {
  /*jshint validthis:true */
  var Constructor = this;
  var promise = new Constructor(noop);
  reject(promise, reason);
  return promise;
}

function needsResolver() {
  throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
}

function needsNew() {
  throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
}

/**
  Promise objects represent the eventual result of an asynchronous operation. The
  primary way of interacting with a promise is through its `then` method, which
  registers callbacks to receive either a promise's eventual value or the reason
  why the promise cannot be fulfilled.

  Terminology
  -----------

  - `promise` is an object or function with a `then` method whose behavior conforms to this specification.
  - `thenable` is an object or function that defines a `then` method.
  - `value` is any legal JavaScript value (including undefined, a thenable, or a promise).
  - `exception` is a value that is thrown using the throw statement.
  - `reason` is a value that indicates why a promise was rejected.
  - `settled` the final resting state of a promise, fulfilled or rejected.

  A promise can be in one of three states: pending, fulfilled, or rejected.

  Promises that are fulfilled have a fulfillment value and are in the fulfilled
  state.  Promises that are rejected have a rejection reason and are in the
  rejected state.  A fulfillment value is never a thenable.

  Promises can also be said to *resolve* a value.  If this value is also a
  promise, then the original promise's settled state will match the value's
  settled state.  So a promise that *resolves* a promise that rejects will
  itself reject, and a promise that *resolves* a promise that fulfills will
  itself fulfill.


  Basic Usage:
  ------------

  ```js
  let promise = new Promise(function(resolve, reject) {
    // on success
    resolve(value);

    // on failure
    reject(reason);
  });

  promise.then(function(value) {
    // on fulfillment
  }, function(reason) {
    // on rejection
  });
  ```

  Advanced Usage:
  ---------------

  Promises shine when abstracting away asynchronous interactions such as
  `XMLHttpRequest`s.

  ```js
  function getJSON(url) {
    return new Promise(function(resolve, reject){
      let xhr = new XMLHttpRequest();

      xhr.open('GET', url);
      xhr.onreadystatechange = handler;
      xhr.responseType = 'json';
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.send();

      function handler() {
        if (this.readyState === this.DONE) {
          if (this.status === 200) {
            resolve(this.response);
          } else {
            reject(new Error('getJSON: `' + url + '` failed with status: [' + this.status + ']'));
          }
        }
      };
    });
  }

  getJSON('/posts.json').then(function(json) {
    // on fulfillment
  }, function(reason) {
    // on rejection
  });
  ```

  Unlike callbacks, promises are great composable primitives.

  ```js
  Promise.all([
    getJSON('/posts'),
    getJSON('/comments')
  ]).then(function(values){
    values[0] // => postsJSON
    values[1] // => commentsJSON

    return values;
  });
  ```

  @class Promise
  @param {Function} resolver
  Useful for tooling.
  @constructor
*/

var Promise$1 = function () {
  function Promise(resolver) {
    this[PROMISE_ID] = nextId();
    this._result = this._state = undefined;
    this._subscribers = [];

    if (noop !== resolver) {
      typeof resolver !== 'function' && needsResolver();
      this instanceof Promise ? initializePromise(this, resolver) : needsNew();
    }
  }

  /**
  The primary way of interacting with a promise is through its `then` method,
  which registers callbacks to receive either a promise's eventual value or the
  reason why the promise cannot be fulfilled.
   ```js
  findUser().then(function(user){
    // user is available
  }, function(reason){
    // user is unavailable, and you are given the reason why
  });
  ```
   Chaining
  --------
   The return value of `then` is itself a promise.  This second, 'downstream'
  promise is resolved with the return value of the first promise's fulfillment
  or rejection handler, or rejected if the handler throws an exception.
   ```js
  findUser().then(function (user) {
    return user.name;
  }, function (reason) {
    return 'default name';
  }).then(function (userName) {
    // If `findUser` fulfilled, `userName` will be the user's name, otherwise it
    // will be `'default name'`
  });
   findUser().then(function (user) {
    throw new Error('Found user, but still unhappy');
  }, function (reason) {
    throw new Error('`findUser` rejected and we're unhappy');
  }).then(function (value) {
    // never reached
  }, function (reason) {
    // if `findUser` fulfilled, `reason` will be 'Found user, but still unhappy'.
    // If `findUser` rejected, `reason` will be '`findUser` rejected and we're unhappy'.
  });
  ```
  If the downstream promise does not specify a rejection handler, rejection reasons will be propagated further downstream.
   ```js
  findUser().then(function (user) {
    throw new PedagogicalException('Upstream error');
  }).then(function (value) {
    // never reached
  }).then(function (value) {
    // never reached
  }, function (reason) {
    // The `PedgagocialException` is propagated all the way down to here
  });
  ```
   Assimilation
  ------------
   Sometimes the value you want to propagate to a downstream promise can only be
  retrieved asynchronously. This can be achieved by returning a promise in the
  fulfillment or rejection handler. The downstream promise will then be pending
  until the returned promise is settled. This is called *assimilation*.
   ```js
  findUser().then(function (user) {
    return findCommentsByAuthor(user);
  }).then(function (comments) {
    // The user's comments are now available
  });
  ```
   If the assimliated promise rejects, then the downstream promise will also reject.
   ```js
  findUser().then(function (user) {
    return findCommentsByAuthor(user);
  }).then(function (comments) {
    // If `findCommentsByAuthor` fulfills, we'll have the value here
  }, function (reason) {
    // If `findCommentsByAuthor` rejects, we'll have the reason here
  });
  ```
   Simple Example
  --------------
   Synchronous Example
   ```javascript
  let result;
   try {
    result = findResult();
    // success
  } catch(reason) {
    // failure
  }
  ```
   Errback Example
   ```js
  findResult(function(result, err){
    if (err) {
      // failure
    } else {
      // success
    }
  });
  ```
   Promise Example;
   ```javascript
  findResult().then(function(result){
    // success
  }, function(reason){
    // failure
  });
  ```
   Advanced Example
  --------------
   Synchronous Example
   ```javascript
  let author, books;
   try {
    author = findAuthor();
    books  = findBooksByAuthor(author);
    // success
  } catch(reason) {
    // failure
  }
  ```
   Errback Example
   ```js
   function foundBooks(books) {
   }
   function failure(reason) {
   }
   findAuthor(function(author, err){
    if (err) {
      failure(err);
      // failure
    } else {
      try {
        findBoooksByAuthor(author, function(books, err) {
          if (err) {
            failure(err);
          } else {
            try {
              foundBooks(books);
            } catch(reason) {
              failure(reason);
            }
          }
        });
      } catch(error) {
        failure(err);
      }
      // success
    }
  });
  ```
   Promise Example;
   ```javascript
  findAuthor().
    then(findBooksByAuthor).
    then(function(books){
      // found books
  }).catch(function(reason){
    // something went wrong
  });
  ```
   @method then
  @param {Function} onFulfilled
  @param {Function} onRejected
  Useful for tooling.
  @return {Promise}
  */

  /**
  `catch` is simply sugar for `then(undefined, onRejection)` which makes it the same
  as the catch block of a try/catch statement.
  ```js
  function findAuthor(){
  throw new Error('couldn't find that author');
  }
  // synchronous
  try {
  findAuthor();
  } catch(reason) {
  // something went wrong
  }
  // async with promises
  findAuthor().catch(function(reason){
  // something went wrong
  });
  ```
  @method catch
  @param {Function} onRejection
  Useful for tooling.
  @return {Promise}
  */


  Promise.prototype.catch = function _catch(onRejection) {
    return this.then(null, onRejection);
  };

  /**
    `finally` will be invoked regardless of the promise's fate just as native
    try/catch/finally behaves
  
    Synchronous example:
  
    ```js
    findAuthor() {
      if (Math.random() > 0.5) {
        throw new Error();
      }
      return new Author();
    }
  
    try {
      return findAuthor(); // succeed or fail
    } catch(error) {
      return findOtherAuther();
    } finally {
      // always runs
      // doesn't affect the return value
    }
    ```
  
    Asynchronous example:
  
    ```js
    findAuthor().catch(function(reason){
      return findOtherAuther();
    }).finally(function(){
      // author was either found, or not
    });
    ```
  
    @method finally
    @param {Function} callback
    @return {Promise}
  */


  Promise.prototype.finally = function _finally(callback) {
    var promise = this;
    var constructor = promise.constructor;

    if (isFunction(callback)) {
      return promise.then(function (value) {
        return constructor.resolve(callback()).then(function () {
          return value;
        });
      }, function (reason) {
        return constructor.resolve(callback()).then(function () {
          throw reason;
        });
      });
    }

    return promise.then(callback, callback);
  };

  return Promise;
}();

Promise$1.prototype.then = then;
Promise$1.all = all;
Promise$1.race = race;
Promise$1.resolve = resolve$1;
Promise$1.reject = reject$1;
Promise$1._setScheduler = setScheduler;
Promise$1._setAsap = setAsap;
Promise$1._asap = asap;

/*global self*/
function polyfill() {
  var local = void 0;

  if (typeof global !== 'undefined') {
    local = global;
  } else if (typeof self !== 'undefined') {
    local = self;
  } else {
    try {
      local = Function('return this')();
    } catch (e) {
      throw new Error('polyfill failed because global object is unavailable in this environment');
    }
  }

  var P = local.Promise;

  if (P) {
    var promiseToString = null;
    try {
      promiseToString = Object.prototype.toString.call(P.resolve());
    } catch (e) {
      // silently ignored
    }

    if (promiseToString === '[object Promise]' && !P.cast) {
      return;
    }
  }

  local.Promise = Promise$1;
}

// Strange compat..
Promise$1.polyfill = polyfill;
Promise$1.Promise = Promise$1;

return Promise$1;

})));





}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"_process":122}],"inherits":[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }
      })
    }
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    if (superCtor) {
      ctor.super_ = superCtor
      var TempCtor = function () {}
      TempCtor.prototype = superCtor.prototype
      ctor.prototype = new TempCtor()
      ctor.prototype.constructor = ctor
    }
  }
}

},{}],"kurento-client-core":[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module core
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

Object.defineProperty(exports, 'name',    {value: 'core'});
Object.defineProperty(exports, 'version', {value: '6.11.0'});


var HubPort = require('./HubPort');
var MediaPipeline = require('./MediaPipeline');
var PassThrough = require('./PassThrough');


exports.HubPort = HubPort;
exports.MediaPipeline = MediaPipeline;
exports.PassThrough = PassThrough;

exports.abstracts    = require('./abstracts');
exports.complexTypes = require('./complexTypes');

},{"./HubPort":27,"./MediaPipeline":28,"./PassThrough":29,"./abstracts":40,"./complexTypes":83}],"kurento-client-elements":[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module elements
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

Object.defineProperty(exports, 'name',    {value: 'elements'});
Object.defineProperty(exports, 'version', {value: '6.6.1'});


var AlphaBlending = require('./AlphaBlending');
var Composite = require('./Composite');
var Dispatcher = require('./Dispatcher');
var DispatcherOneToMany = require('./DispatcherOneToMany');
var HttpPostEndpoint = require('./HttpPostEndpoint');
var Mixer = require('./Mixer');
var PlayerEndpoint = require('./PlayerEndpoint');
var RecorderEndpoint = require('./RecorderEndpoint');
var RtpEndpoint = require('./RtpEndpoint');
var WebRtcEndpoint = require('./WebRtcEndpoint');


exports.AlphaBlending = AlphaBlending;
exports.Composite = Composite;
exports.Dispatcher = Dispatcher;
exports.DispatcherOneToMany = DispatcherOneToMany;
exports.HttpPostEndpoint = HttpPostEndpoint;
exports.Mixer = Mixer;
exports.PlayerEndpoint = PlayerEndpoint;
exports.RecorderEndpoint = RecorderEndpoint;
exports.RtpEndpoint = RtpEndpoint;
exports.WebRtcEndpoint = WebRtcEndpoint;

exports.abstracts    = require('./abstracts');
exports.complexTypes = require('./complexTypes');

},{"./AlphaBlending":84,"./Composite":85,"./Dispatcher":86,"./DispatcherOneToMany":87,"./HttpPostEndpoint":88,"./Mixer":89,"./PlayerEndpoint":90,"./RecorderEndpoint":91,"./RtpEndpoint":92,"./WebRtcEndpoint":93,"./abstracts":95,"./complexTypes":105}],"kurento-client-filters":[function(require,module,exports){
/* Autogenerated with Kurento Idl */

/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module filters
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

Object.defineProperty(exports, 'name',    {value: 'filters'});
Object.defineProperty(exports, 'version', {value: '6.6.1'});


var FaceOverlayFilter = require('./FaceOverlayFilter');
var GStreamerFilter = require('./GStreamerFilter');
var ImageOverlayFilter = require('./ImageOverlayFilter');
var ZBarFilter = require('./ZBarFilter');


exports.FaceOverlayFilter = FaceOverlayFilter;
exports.GStreamerFilter = GStreamerFilter;
exports.ImageOverlayFilter = ImageOverlayFilter;
exports.ZBarFilter = ZBarFilter;

exports.abstracts = require('./abstracts');

},{"./FaceOverlayFilter":106,"./GStreamerFilter":107,"./ImageOverlayFilter":108,"./ZBarFilter":109,"./abstracts":111}],"kurento-client":[function(require,module,exports){
/*
 * (C) Copyright 2013-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

/**
 * Media API for the Kurento Web SDK
 *
 * @module kurentoClient
 *
 * @copyright 2013-2015 Kurento (http://kurento.org/)
 * @license ALv2
 */

require('error-tojson');

var checkType = require('./checkType');

var disguise = require('./disguise')
var MediaObjectCreator = require('./MediaObjectCreator');
var register = require('./register');
var TransactionsManager = require('./TransactionsManager');

exports.checkType = checkType;
exports.disguise = disguise;
exports.MediaObjectCreator = MediaObjectCreator;
exports.register = register;
exports.TransactionsManager = TransactionsManager;

// Export KurentoClient

var KurentoClient = require('./KurentoClient');

module.exports = KurentoClient;
KurentoClient.KurentoClient = KurentoClient;

// Ugly hack due to circular references

KurentoClient.checkType = checkType;
KurentoClient.disguise = disguise;
KurentoClient.MediaObjectCreator = MediaObjectCreator;
KurentoClient.register = register;
KurentoClient.TransactionsManager = TransactionsManager;

// Register Kurento basic elements

register('kurento-client-core')
register('kurento-client-elements')
register('kurento-client-filters')

},{"./KurentoClient":1,"./MediaObjectCreator":2,"./TransactionsManager":3,"./checkType":5,"./disguise":7,"./register":8,"error-tojson":20}],"promisecallback":[function(require,module,exports){
/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * All rights reserved. This program and the accompanying materials are made
 * available under the terms of the GNU Lesser General Public License (LGPL)
 * version 2.1 which accompanies this distribution, and is available at
 * http://www.gnu.org/licenses/lgpl-2.1.html
 *
 * This library is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU Lesser General Public License for more
 * details.
 */


/**
 * Define a callback as the continuation of a promise
 */
function promiseCallback(promise, callback, thisArg)
{
  if(callback)
  {
    function callback2(error, result)
    {
      try
      {
        return callback.call(thisArg, error, result);
      }
      catch(exception)
      {
        // Show the exception in the console with its full stack trace
        console.trace(exception);
        throw exception;
      }
    };

    promise = promise.then(callback2.bind(undefined, null), callback2);
  };

  return promise
};


module.exports = promiseCallback;

},{}]},{},[4]);
