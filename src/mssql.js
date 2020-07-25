module.exports = function (RED) {
    'use strict';
    var mustache = require('mustache');
    const sql = require('mssql');

    /**
     * extractTokens - borrowed from @0node-red/nodes/core/core/80-template.js
     */
    function extractTokens(tokens,set) {
        set = set || new Set();
        tokens.forEach(function(token) {
            if (token[0] !== 'text') {
                set.add(token[1]);
                if (token.length > 4) {
                    extractTokens(token[4],set);
                }
            }
        });
        return set;
    }

    /**
     * parseContext - borrowed from @0node-red/nodes/core/core/80-template.js
     */
    function parseContext(key) {
        var match = /^(flow|global)(\[(\w+)\])?\.(.+)/.exec(key);
        if (match) {
            var parts = {};
            parts.type = match[1];
            parts.store = (match[3] === '') ? "default" : match[3];
            parts.field = match[4];
            return parts;
        }
        return undefined;
    }

    /**
     * checks if `n` is a valid number.
     * @param {string | number} n 
     */
    function isNumber(n) {
        return !isNaN(parseFloat(n)) && isFinite(n);
    }

    /**
     * Parse a string or number into an integer and return it.
     * If `n` cannot be parsed, `defaultValue` is returned instead.
     * @param {string | number} n 
     * @param {boolean} defaultValue - the value to return if `n` is not a valid number
     * @returns {integer} `n` parsed to an integer or `defaultValue` if `n` is invalid
     */
    function safeParseInt(n, defaultValue){
        try {
            var x = parseInt(n);
            if(isNumber(x)){
                return x;
            }    
        } catch (error) { 
            //do nothing
        }
        return defaultValue;
    }

    /**
     * NodeContext - borrowed from @0node-red/nodes/core/core/80-template.js
     */
    function NodeContext(msg, nodeContext, parent, escapeStrings, cachedContextTokens) {
        this.msgContext = new mustache.Context(msg,parent);
        this.nodeContext = nodeContext;
        this.escapeStrings = escapeStrings;
        this.cachedContextTokens = cachedContextTokens;
    }

    NodeContext.prototype = new mustache.Context();

    NodeContext.prototype.lookup = function (name) {
        // try message first:
        try {
            var value = this.msgContext.lookup(name);
            if (value !== undefined) {
                if (this.escapeStrings && typeof value === "string") {
                    value = value.replace(/\\/g, "\\\\");
                    value = value.replace(/\n/g, "\\n");
                    value = value.replace(/\t/g, "\\t");
                    value = value.replace(/\r/g, "\\r");
                    value = value.replace(/\f/g, "\\f");
                    value = value.replace(/[\b]/g, "\\b");
                }
                return value;
            }

            // try flow/global context:
            var context = parseContext(name);
            if (context) {
                var type = context.type;
                var store = context.store;
                var field = context.field;
                var target = this.nodeContext[type];
                if (target) {
                    return this.cachedContextTokens[name];
                }
            }
            return '';
        }
        catch(err) {
            throw err;
        }
    }

    NodeContext.prototype.push = function push (view) {
        return new NodeContext(view, this.nodeContext, this.msgContext, undefined, this.cachedContextTokens);
    };

    function connection(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        //add mustache transformation to connection object
        var configStr = JSON.stringify(config)
        var transform = mustache.render(configStr, process.env);
        config = JSON.parse(transform);
        
        //add mustache transformation to credentials object
        try {
            var credStr = JSON.stringify(node.credentials)
            var transform = mustache.render(credStr, process.env);
            node.credentials = JSON.parse(transform);
        } catch (error) {
            console.error(error);
        }
        

        node.config = {
            user: (node.credentials ? node.credentials.username : "") || "",
            password: (node.credentials ? node.credentials.password : "")  || "",
            domain: node.credentials ? node.credentials.domain : "",
            server: config.server,
            database: config.database,
            options: {
                port: config.port ? safeParseInt(config.port, 1433) : undefined,
                tdsVersion: config.tdsVersion || "7_4",
                encrypt: config.encyption,
                useUTC: config.useUTC,
                connectTimeout: config.connectTimeout ? safeParseInt(config.connectTimeout, 15000) : undefined,
                requestTimeout: config.requestTimeout ? safeParseInt(config.requestTimeout, 15000) : undefined,
                cancelTimeout: config.cancelTimeout ? safeParseInt(config.cancelTimeout, 5000) : undefined,
                camelCaseColumns: config.camelCaseColumns == "true" ? true : undefined,
                parseJSON: config.parseJSON,
            },
            pool: {
                max: safeParseInt(config.pool, 5),
                min: 0,
                idleTimeoutMillis: 3000,
                //log: (message, logLevel) => console.log(`POOL: [${logLevel}] ${message}`)
            }
        };

        //config options seem to differ between pool and tedious connection
        //so for compatibility I just repeat the ones that differ so they get picked up in _poolCreate ()
        node.config.port = node.config.options.port;
        node.config.connectionTimeout = node.config.options.connectTimeout;
        node.config.requestTimeout = node.config.options.requestTimeout;
        node.config.cancelTimeout = node.config.options.cancelTimeout;
        node.config.encrypt = node.config.options.encrypt;

        node.connectedNodes = [];   

        node.connectionCleanup = function() {
            try {
                if(node.pool){
                    node.log(`Disconnecting server : ${node.config.server}, database : ${node.config.database}, port : ${node.config.options.port}, user : ${node.config.server}`);
                    node.pool.then(_ => _.close()).catch(e => { console.error(e); });    
                }
            }
            catch (error) {
            }
            try {
                if(node.connectionPool) node.connectionPool.close();
            }
            catch (error) {
            }
            node.status({
                fill: 'grey',
                shape: 'dot',
                text: 'disconnected'
            });
            node.pool = null;
        }

        node.connectionPool = new sql.ConnectionPool(node.config)
        node.connectionPool.on('error', err => {
            node.error(err);
            node.connectionCleanup();
        }) 

        node.connect = function(){
            if(node.pool){
                return;
            }
            node.status({
                fill: 'yellow',
                shape: 'dot',
                text: 'connecting'
            });
            node.pool = node.connectionPool.connect()
            .then(_ => { 
                node.log(`Connected to server : ${node.config.server}, database : ${node.config.database}, port : ${node.config.options.port}, user : ${node.config.user}`);
                return _ 
            }).catch(e => {
                node.log(`Error connecting to server : ${node.config.server}, database : ${node.config.database}, port : ${node.config.options.port}, user : ${node.config.user}`);
                throw e;
            });
        }

        node.execSql = function(sql, callback) {
            node.connect();
            node.pool.then(_ => {
                return _.request().query(sql);
            }).then(result => {
                callback(null,result);
            }).catch(e => { 
                console.error(e)
                node.pool = null;
                callback(e); 
            })
        };
        node.disconnect = function (nodeId) {
            let index = node.connectedNodes.indexOf(nodeId);
            if (index >= 0) {
                node.connectedNodes.splice(index, 1);
            }
            if (node.connectedNodes.length === 0) {
                node.connectionCleanup();
            }
        }
    }

    RED.nodes.registerType('MSSQL-CN', connection, {
        credentials: {
            username: {
                type: 'text'
            },
            password: {
                type: 'password'
            },
            domain: {
                type: 'text'
            }
        }
    });

    function mssql(config) {
        RED.nodes.createNode(this, config);
        var mssqlCN = RED.nodes.getNode(config.mssqlCN);
        var node = this;

        node.query = config.query;
        node.outField = config.outField;
        node.returnType = config.returnType;
        node.throwErrors = !config.throwErrors || config.throwErrors == "0" ? false : true;

        var setResult = function (msg, field, value, returnType = 0 ) {
            let setValue = returnType == 1 ? value : value && value.recordset;
            if(!setValue) return;
            const set = (obj, path, val) => { 
                const keys = path.split('.');
                const lastKey = keys.pop();
                const lastObj = keys.reduce((obj, key) => 
                    obj[key] = obj[key] || {}, 
                    obj); 
                lastObj[lastKey] = val;
            }
            set(msg, field, setValue);
        };

        node.processError = function(err,msg){
            let errMsg = "Error";
            if(typeof err == "string"){
                errMsg = err;
                msg.error = err;
            } else if(err && err.message) {
                errMsg = err.message;

                if (err.precedingErrors !== undefined 
                    && err.precedingErrors.length
                    && err.precedingErrors[0].originalError !== undefined 
                    && err.precedingErrors[0].originalError.info !== null
                    && err.precedingErrors[0].originalError.info.message !== null){
                    errMsg += ' ('+err.precedingErrors[0].originalError.info.message+')';
                }
                //Make an error object from the err.  NOTE: We cant just assign err to msg.error as a promise 
                //rejection occurs when the node has 2 wires on the output. 
                //(redUtil.cloneMessage(m) causes error "node-red Cannot assign to read only property 'originalError'")
                msg.error = {
                    class: err.class,
                    code: err.code, 
                    lineNumber: err.lineNumber, 
                    message: err.message, 
					details: errMsg, 									 
                    name: err.name, 
                    number: err.number, 
                    procName: err.procName, 
                    serverName: err.serverName, 
                    state: err.state, 
                    toString: function(){
                        return this.message;
                    }
                }
            }
            
            node.status({
                fill: 'red',
                shape: 'ring',
                text: errMsg
            });

            if(node.throwErrors){
                node.error(msg.error,msg);
            } else {
                node.log(err);
                node.send(msg);
            }
        }    

        node.on('input', function (msg) {
            
            node.status({}); //clear node status
            delete msg.error; //remove any .error property passed in from previous node
            msg.query = node.query || msg.payload;

            var promises = [];
            var tokens = extractTokens(mustache.parse(msg.query));
            var resolvedTokens = {};
            tokens.forEach(function(name) {
                var context = parseContext(name);
                if (context) {
                    var type = context.type;
                    var store = context.store;
                    var field = context.field;
                    var target = node.context()[type];
                    if (target) {
                        var promise = new Promise((resolve, reject) => {
                            target.get(field, store, (err, val) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolvedTokens[name] = val;
                                    resolve();
                                }
                            });
                        });
                        promises.push(promise);
                        return;
                    }
                }
            });

            Promise.all(promises).then(function() {
                var value = mustache.render(msg.query, new NodeContext(msg, node.context(), null, false, resolvedTokens));
                msg.query = value;
                doSQL(node, msg);
            }).catch(function (err) {
                node.processError(err,msg)
            });           
        });
   
        function doSQL(node, msg){
            node.status({
                fill: 'blue',
                shape: 'dot',
                text: 'requesting'
            });

            try {
                mssqlCN.execSql(msg.query, function (err, data) {
                    if (err) {
                        node.processError(err,msg)
                    } else {
                        node.status({
                            fill: 'green',
                            shape: 'dot',
                            text: 'done'
                        });
                        setResult(msg, node.outField, data, node.returnType);
                        node.send(msg);
                    }
                });
            } catch (err) {
                node.processError(err,msg)
            }
        }
        node.on('close', function () {
            mssqlCN.disconnect(node.id);
        });
    }
    RED.nodes.registerType('MSSQL', mssql);
};
