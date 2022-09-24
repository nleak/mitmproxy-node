"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const child_process_1 = require("child_process");
const path_1 = require("path");
const url_1 = require("url");
const http_1 = require("http");
const https_1 = require("https");
const net_1 = require("net");
/**
 * Wait for the specified port to open.
 * @param port The port to watch for.
 * @param retries The number of times to retry before giving up. Defaults to 10.
 * @param interval The interval between retries, in milliseconds. Defaults to 500.
 */
function waitForPort(port, retries = 10, interval = 500) {
    return new Promise((resolve, reject) => {
        let retriesRemaining = retries;
        let retryInterval = interval;
        let timer = null;
        let socket = null;
        function clearTimerAndDestroySocket() {
            clearTimeout(timer);
            timer = null;
            if (socket)
                socket.destroy();
            socket = null;
        }
        function retry() {
            tryToConnect();
        }
        function tryToConnect() {
            clearTimerAndDestroySocket();
            if (--retriesRemaining < 0) {
                reject(new Error('out of retries'));
            }
            socket = net_1.createConnection(port, "localhost", function () {
                clearTimerAndDestroySocket();
                if (retriesRemaining >= 0)
                    resolve();
            });
            timer = setTimeout(function () { retry(); }, retryInterval);
            socket.on('error', function (err) {
                clearTimerAndDestroySocket();
                setTimeout(retry, retryInterval);
            });
        }
        tryToConnect();
    });
}
/**
 * An interceptor that does nothing.
 */
function nopInterceptor(m) { }
exports.nopInterceptor = nopInterceptor;
/**
 * Abstract class that represents HTTP headers.
 */
class AbstractHTTPHeaders {
    // The raw headers, as a sequence of key/value pairs.
    // Since header fields may be repeated, this array may contain multiple entries for the same key.
    get headers() {
        return this._headers;
    }
    constructor(headers) {
        this._headers = headers;
    }
    _indexOfHeader(name) {
        const headers = this.headers;
        const len = headers.length;
        for (let i = 0; i < len; i++) {
            if (headers[i][0].toLowerCase() === name) {
                return i;
            }
        }
        return -1;
    }
    /**
     * Get the value of the given header field.
     * If there are multiple fields with that name, this only returns the first field's value!
     * @param name Name of the header field
     */
    getHeader(name) {
        const index = this._indexOfHeader(name.toLowerCase());
        if (index !== -1) {
            return this.headers[index][1];
        }
        return '';
    }
    /**
     * Set the value of the given header field. Assumes that there is only one field with the given name.
     * If the field does not exist, it adds a new field with the name and value.
     * @param name Name of the field.
     * @param value New value.
     */
    setHeader(name, value) {
        const index = this._indexOfHeader(name.toLowerCase());
        if (index !== -1) {
            this.headers[index][1] = value;
        }
        else {
            this.headers.push([name, value]);
        }
    }
    /**
     * Removes the header field with the given name. Assumes that there is only one field with the given name.
     * Does nothing if field does not exist.
     * @param name Name of the field.
     */
    removeHeader(name) {
        const index = this._indexOfHeader(name.toLowerCase());
        if (index !== -1) {
            this.headers.splice(index, 1);
        }
    }
    /**
     * Removes all header fields.
     */
    clearHeaders() {
        this._headers = [];
    }
}
exports.AbstractHTTPHeaders = AbstractHTTPHeaders;
/**
 * Represents a MITM-ed HTTP response from a server.
 */
class InterceptedHTTPResponse extends AbstractHTTPHeaders {
    constructor(metadata) {
        super(metadata.headers);
        this.statusCode = metadata.status_code;
        // We don't support chunked transfers. The proxy already de-chunks it for us.
        this.removeHeader('transfer-encoding');
        // MITMProxy decodes the data for us.
        this.removeHeader('content-encoding');
        // CSP is bad!
        this.removeHeader('content-security-policy');
        this.removeHeader('x-webkit-csp');
        this.removeHeader('x-content-security-policy');
    }
    toJSON() {
        return {
            status_code: this.statusCode,
            headers: this.headers
        };
    }
}
exports.InterceptedHTTPResponse = InterceptedHTTPResponse;
/**
 * Represents an intercepted HTTP request from a client.
 */
class InterceptedHTTPRequest extends AbstractHTTPHeaders {
    constructor(metadata) {
        super(metadata.headers);
        this.method = metadata.method.toLowerCase();
        this.rawUrl = metadata.url;
        this.url = url_1.parse(this.rawUrl);
    }
}
exports.InterceptedHTTPRequest = InterceptedHTTPRequest;
/**
 * Represents an intercepted HTTP request/response pair.
 */
class InterceptedHTTPMessage {
    /**
     * Unpack from a Buffer received from MITMProxy.
     * @param b
     */
    static FromBuffer(b) {
        const metadataSize = b.readInt32LE(0);
        const requestSize = b.readInt32LE(4);
        const responseSize = b.readInt32LE(8);
        const metadata = JSON.parse(b.toString("utf8", 12, 12 + metadataSize));
        return new InterceptedHTTPMessage(new InterceptedHTTPRequest(metadata.request), new InterceptedHTTPResponse(metadata.response), b.slice(12 + metadataSize, 12 + metadataSize + requestSize), b.slice(12 + metadataSize + requestSize, 12 + metadataSize + requestSize + responseSize));
    }
    // The body of the HTTP response. Read-only; change the response body via setResponseBody.
    get responseBody() {
        return this._responseBody;
    }
    constructor(request, response, requestBody, responseBody) {
        this.request = request;
        this.response = response;
        this.requestBody = requestBody;
        this._responseBody = responseBody;
    }
    /**
     * Changes the body of the HTTP response. Appropriately updates content-length.
     * @param b The new body contents.
     */
    setResponseBody(b) {
        this._responseBody = b;
        // Update content-length.
        this.response.setHeader('content-length', `${b.length}`);
        // TODO: Content-encoding?
    }
    /**
     * Changes the status code of the HTTP response.
     * @param code The new status code.
     */
    setStatusCode(code) {
        this.response.statusCode = code;
    }
    /**
     * Pack into a buffer for transmission to MITMProxy.
     */
    toBuffer() {
        const metadata = Buffer.from(JSON.stringify(this.response), 'utf8');
        const metadataLength = metadata.length;
        const responseLength = this._responseBody.length;
        const rv = Buffer.alloc(8 + metadataLength + responseLength);
        rv.writeInt32LE(metadataLength, 0);
        rv.writeInt32LE(responseLength, 4);
        metadata.copy(rv, 8);
        this._responseBody.copy(rv, 8 + metadataLength);
        return rv;
    }
}
exports.InterceptedHTTPMessage = InterceptedHTTPMessage;
class StashedItem {
    constructor(rawUrl, mimeType, data) {
        this.rawUrl = rawUrl;
        this.mimeType = mimeType;
        this.data = data;
    }
    get shortMimeType() {
        let mime = this.mimeType.toLowerCase();
        if (mime.indexOf(";") !== -1) {
            mime = mime.slice(0, mime.indexOf(";"));
        }
        return mime;
    }
    get isHtml() {
        return this.shortMimeType === "text/html";
    }
    get isJavaScript() {
        switch (this.shortMimeType) {
            case 'text/javascript':
            case 'application/javascript':
            case 'text/x-javascript':
            case 'application/x-javascript':
                return true;
            default:
                return false;
        }
    }
}
exports.StashedItem = StashedItem;
function defaultStashFilter(url, item) {
    return item.isJavaScript || item.isHtml;
}
/**
 * Class that launches MITM proxy and talks to it via WebSockets.
 */
class MITMProxy {
    constructor(cb, onlyInterceptTextFiles) {
        this._stashEnabled = false;
        this._mitmProcess = null;
        this._mitmError = null;
        this._wss = null;
        this._stash = new Map();
        this._stashFilter = defaultStashFilter;
        this.cb = cb;
        this.onlyInterceptTextFiles = onlyInterceptTextFiles;
    }
    /**
     * Creates a new MITMProxy instance.
     * @param cb Called with intercepted HTTP requests / responses.
     * @param interceptPaths List of paths to completely intercept without sending to the server (e.g. ['/eval'])
     * @param quiet If true, do not print debugging messages (defaults to 'true').
     * @param onlyInterceptTextFiles If true, only intercept text files (JavaScript/HTML/CSS/etc, and ignore media files).
     */
    static Create(cb = nopInterceptor, interceptPaths = [], quiet = true, onlyInterceptTextFiles = false, ignoreHosts = null) {
        return __awaiter(this, void 0, void 0, function* () {
            // Construct WebSocket server, and wait for it to begin listening.
            const wss = new ws_1.Server({ port: 8765 });
            const proxyConnected = new Promise((resolve, reject) => {
                wss.once('connection', () => {
                    resolve();
                });
            });
            const mp = new MITMProxy(cb, onlyInterceptTextFiles);
            // Set up WSS callbacks before MITMProxy connects.
            mp._initializeWSS(wss);
            yield new Promise((resolve, reject) => {
                wss.once('listening', () => {
                    wss.removeListener('error', reject);
                    resolve();
                });
                wss.once('error', reject);
            });
            try {
                try {
                    yield waitForPort(8080, 1);
                    if (!quiet) {
                        console.log(`MITMProxy already running.`);
                    }
                }
                catch (e) {
                    if (!quiet) {
                        console.log(`MITMProxy not running; starting up mitmproxy.`);
                    }
                    // Start up MITM process.
                    // --anticache means to disable caching, which gets in the way of transparently rewriting content.
                    const scriptArgs = interceptPaths.length > 0 ? ["--set", `intercept=${interceptPaths.join(",")}`] : [];
                    scriptArgs.push("--set", `onlyInterceptTextFiles=${onlyInterceptTextFiles}`);
                    if (ignoreHosts) {
                        scriptArgs.push(`--ignore-hosts`, ignoreHosts);
                    }
                    const options = ["--anticache", "-s", path_1.resolve(__dirname, `../scripts/proxy.py`)].concat(scriptArgs);
                    if (quiet) {
                        options.push('-q');
                    }
                    // allow self-signed SSL certificates
                    options.push("--ssl-insecure");
                    const mitmProcess = child_process_1.spawn("mitmdump", options, {
                        stdio: 'inherit'
                    });
                    const mitmProxyExited = new Promise((_, reject) => {
                        mitmProcess.once('error', reject);
                        mitmProcess.once('exit', reject);
                    });
                    if (MITMProxy._activeProcesses.push(mitmProcess) === 1) {
                        process.on('SIGINT', MITMProxy._cleanup);
                        process.on('exit', MITMProxy._cleanup);
                    }
                    mp._initializeMITMProxy(mitmProcess);
                    // Wait for port 8080 to come online.
                    const waitingForPort = waitForPort(8080);
                    try {
                        // Fails if mitmproxy exits before port becomes available.
                        yield Promise.race([mitmProxyExited, waitingForPort]);
                    }
                    catch (e) {
                        if (e && typeof (e) === 'object' && e.code === "ENOENT") {
                            throw new Error(`mitmdump, which is an executable that ships with mitmproxy, is not on your PATH. Please ensure that you can run mitmdump --version successfully from your command line.`);
                        }
                        else {
                            throw new Error(`Unable to start mitmproxy: ${e}`);
                        }
                    }
                }
                yield proxyConnected;
            }
            catch (e) {
                yield new Promise((resolve) => wss.close(resolve));
                throw e;
            }
            return mp;
        });
    }
    static _cleanup() {
        if (MITMProxy._cleanupCalled) {
            return;
        }
        MITMProxy._cleanupCalled = true;
        MITMProxy._activeProcesses.forEach((p) => {
            p.kill('SIGKILL');
        });
    }
    // Toggle whether or not mitmproxy-node stashes modified server responses.
    // **Not used for performance**, but enables Node.js code to fetch previous server responses from the proxy.
    get stashEnabled() {
        return this._stashEnabled;
    }
    set stashEnabled(v) {
        if (!v) {
            this._stash.clear();
        }
        this._stashEnabled = v;
    }
    get stashFilter() {
        return this._stashFilter;
    }
    set stashFilter(value) {
        if (typeof (value) === 'function') {
            this._stashFilter = value;
        }
        else if (value === null) {
            this._stashFilter = defaultStashFilter;
        }
        else {
            throw new Error(`Invalid stash filter: Expected a function.`);
        }
    }
    _initializeWSS(wss) {
        this._wss = wss;
        this._wss.on('connection', (ws) => {
            ws.on('error', (e) => {
                if (e.code !== "ECONNRESET") {
                    console.log(`WebSocket error: ${e}`);
                }
            });
            ws.on('message', (message) => __awaiter(this, void 0, void 0, function* () {
                const original = InterceptedHTTPMessage.FromBuffer(message);
                const rv = this.cb(original);
                if (rv && typeof (rv) === 'object' && rv.then) {
                    yield rv;
                }
                // Remove transfer-encoding. We don't support chunked.
                if (this._stashEnabled) {
                    const item = new StashedItem(original.request.rawUrl, original.response.getHeader('content-type'), original.responseBody);
                    if (this._stashFilter(original.request.rawUrl, item)) {
                        this._stash.set(original.request.rawUrl, item);
                    }
                }
                ws.send(original.toBuffer());
            }));
        });
    }
    _initializeMITMProxy(mitmProxy) {
        this._mitmProcess = mitmProxy;
        this._mitmProcess.on('exit', (code, signal) => {
            const index = MITMProxy._activeProcesses.indexOf(this._mitmProcess);
            if (index !== -1) {
                MITMProxy._activeProcesses.splice(index, 1);
            }
            if (code !== null) {
                if (code !== 0) {
                    this._mitmError = new Error(`Process exited with code ${code}.`);
                }
            }
            else {
                this._mitmError = new Error(`Process exited due to signal ${signal}.`);
            }
        });
        this._mitmProcess.on('error', (err) => {
            this._mitmError = err;
        });
    }
    /**
     * Retrieves the given URL from the stash.
     * @param url
     */
    getFromStash(url) {
        return this._stash.get(url);
    }
    forEachStashItem(cb) {
        this._stash.forEach(cb);
    }
    /**
     * Requests the given URL from the proxy.
     */
    proxyGet(urlString) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = url_1.parse(urlString);
            const get = url.protocol === "http:" ? http_1.get : https_1.get;
            return new Promise((resolve, reject) => {
                const req = get({
                    url: urlString,
                    headers: {
                        host: url.host
                    },
                    host: 'localhost',
                    port: 8080,
                    path: urlString
                }, (res) => {
                    const data = new Array();
                    res.on('data', (chunk) => {
                        data.push(chunk);
                    });
                    res.on('end', () => {
                        const d = Buffer.concat(data);
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            body: d
                        });
                    });
                    res.once('error', reject);
                });
                req.once('error', reject);
            });
        });
    }
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            return new Promise((resolve, reject) => {
                const closeWSS = () => {
                    this._wss.close((err) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve();
                        }
                    });
                };
                if (this._mitmProcess && !this._mitmProcess.killed) {
                    this._mitmProcess.once('exit', (code, signal) => {
                        closeWSS();
                    });
                    this._mitmProcess.kill('SIGTERM');
                }
                else {
                    closeWSS();
                }
            });
        });
    }
}
MITMProxy._activeProcesses = [];
MITMProxy._cleanupCalled = false;
exports.default = MITMProxy;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7OztBQUFBLDJCQUE2QztBQUM3QyxpREFBa0Q7QUFDbEQsK0JBQTZCO0FBQzdCLDZCQUEyQztBQUMzQywrQkFBb0M7QUFDcEMsaUNBQXNDO0FBQ3RDLDZCQUE2QztBQUU3Qzs7Ozs7R0FLRztBQUNILHFCQUFxQixJQUFZLEVBQUUsVUFBa0IsRUFBRSxFQUFFLFdBQW1CLEdBQUc7SUFDN0UsT0FBTyxJQUFJLE9BQU8sQ0FBTyxDQUFDLE9BQU8sRUFBRSxNQUFNLEVBQUUsRUFBRTtRQUMzQyxJQUFJLGdCQUFnQixHQUFHLE9BQU8sQ0FBQztRQUMvQixJQUFJLGFBQWEsR0FBRyxRQUFRLENBQUM7UUFDN0IsSUFBSSxLQUFLLEdBQWlCLElBQUksQ0FBQztRQUMvQixJQUFJLE1BQU0sR0FBVyxJQUFJLENBQUM7UUFFMUI7WUFDRSxZQUFZLENBQUMsS0FBSyxDQUFDLENBQUM7WUFDcEIsS0FBSyxHQUFHLElBQUksQ0FBQztZQUNiLElBQUksTUFBTTtnQkFBRSxNQUFNLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDN0IsTUFBTSxHQUFHLElBQUksQ0FBQztRQUNoQixDQUFDO1FBRUQ7WUFDRSxZQUFZLEVBQUUsQ0FBQztRQUNqQixDQUFDO1FBRUQ7WUFDRSwwQkFBMEIsRUFBRSxDQUFDO1lBRTdCLElBQUksRUFBRSxnQkFBZ0IsR0FBRyxDQUFDLEVBQUU7Z0JBQzFCLE1BQU0sQ0FBQyxJQUFJLEtBQUssQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUM7YUFDckM7WUFFRCxNQUFNLEdBQUcsc0JBQWdCLENBQUMsSUFBSSxFQUFFLFdBQVcsRUFBRTtnQkFDM0MsMEJBQTBCLEVBQUUsQ0FBQztnQkFDN0IsSUFBSSxnQkFBZ0IsSUFBSSxDQUFDO29CQUFFLE9BQU8sRUFBRSxDQUFDO1lBQ3ZDLENBQUMsQ0FBQyxDQUFDO1lBRUgs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LEVBQUUsTUFBTSxFQUFFLEVBQUU7Z0JBQzNDLE1BQU0sUUFBUSxHQUFHLEdBQUcsRUFBRTtvQkFDcEIsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRTt3QkFDdEIsSUFBSSxHQUFHLEVBQUU7NEJBQ1AsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO3lCQUNiOzZCQUFNOzRCQUNMLE9BQU8sRUFBRSxDQUFDO3lCQUNYO29CQUNILENBQUMsQ0FBQyxDQUFDO2dCQUNMLENBQUMsQ0FBQztnQkFFRixJQUFJLElBQUksQ0FBQyxZQUFZLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLE1BQU0sRUFBRTtvQkFDbEQsSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLENBQUMsSUFBSSxFQUFFLE1BQU0sRUFBRSxFQUFFO3dCQUM5QyxRQUFRLEVBQUUsQ0FBQztvQkFDYixDQUFDLENBQUMsQ0FBQztvQkFDSCxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztpQkFDbkM7cUJBQU07b0JBQ0wsUUFBUSxFQUFFLENBQUM7aUJBQ1o7WUFDSCxDQUFDLENBQUMsQ0FBQztRQUNMLENBQUM7S0FBQTs7QUF6UGMsMEJBQWdCLEdBQW1CLEVBQUUsQ0FBQztBQXdGdEMsd0JBQWMsR0FBRyxLQUFLLENBQUM7QUF6RnhDLDRCQTJQQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7U2VydmVyIGFzIFdlYlNvY2tldFNlcnZlcn0gZnJvbSAnd3MnO1xuaW1wb3J0IHtzcGF3biwgQ2hpbGRQcm9jZXNzfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcbmltcG9ydCB7cmVzb2x2ZX0gZnJvbSAncGF0aCc7XG5pbXBvcnQge3BhcnNlIGFzIHBhcnNlVVJMLCBVcmx9IGZyb20gJ3VybCc7XG5pbXBvcnQge2dldCBhcyBodHRwR2V0fSBmcm9tICdodHRwJztcbmltcG9ydCB7Z2V0IGFzIGh0dHBzR2V0fSBmcm9tICdodHRwcyc7XG5pbXBvcnQge2NyZWF0ZUNvbm5lY3Rpb24sIFNvY2tldH0gZnJvbSAnbmV0JztcblxuLyoqXG4gKiBXYWl0IGZvciB0aGUgc3BlY2lmaWVkIHBvcnQgdG8gb3Blbi5cbiAqIEBwYXJhbSBwb3J0IFRoZSBwb3J0IHRvIHdhdGNoIGZvci5cbiAqIEBwYXJhbSByZXRyaWVzIFRoZSBudW1iZXIgb2YgdGltZXMgdG8gcmV0cnkgYmVmb3JlIGdpdmluZyB1cC4gRGVmYXVsdHMgdG8gMTAuXG4gKiBAcGFyYW0gaW50ZXJ2YWwgVGhlIGludGVydmFsIGJldHdlZW4gcmV0cmllcywgaW4gbWlsbGlzZWNvbmRzLiBEZWZhdWx0cyB0byA1MDAuXG4gKi9cbmZ1bmN0aW9uIHdhaXRGb3JQb3J0KHBvcnQ6IG51bWJlciwgcmV0cmllczogbnVtYmVyID0gMTAsIGludGVydmFsOiBudW1iZXIgPSA1MDApOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBsZXQgcmV0cmllc1JlbWFpbmluZyA9IHJldHJpZXM7XG4gICAgbGV0IHJldHJ5SW50ZXJ2YWwgPSBpbnRlcnZhbDtcbiAgICBsZXQgdGltZXI6IE5vZGVKUy5UaW1lciA9IG51bGw7XG4gICAgbGV0IHNvY2tldDogU29ja2V0ID0gbnVsbDtcblxuICAgIGZ1bmN0aW9uIGNsZWFyVGltZXJBbmREZXN0cm95U29ja2V0KCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHRpbWVyID0gbnVsbDtcbiAgICAgIGlmIChzb2NrZXQpIHNvY2tldC5kZXN0cm95KCk7XG4gICAgICBzb2NrZXQgPSBudWxsO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJldHJ5KCkge1xuICAgICAgdHJ5VG9Db25uZWN0KCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdHJ5VG9Db25uZWN0KCkge1xuICAgICAgY2xlYXJUaW1lckFuZERlc3Ryb3lTb2NrZXQoKTtcblxuICAgICAgaWYgKC0tcmV0cmllc1JlbWFpbmluZyA8IDApIHtcbiAgICAgICAgcmVqZWN0KG5ldyBFcnJvcignb3V0IG9mIHJldHJpZXMnKSk7XG4gICAgICB9XG5cbiAgICAgIHNvY2tldCA9IGNyZWF0ZUNvbm5lY3Rpb24ocG9ydCwgXCJsb2NhbGhvc3RcIiwgZnVuY3Rpb24oKSB7XG4gICAgICAgIGNsZWFyVGltZXJBbmREZXN0cm95U29ja2V0KCk7XG4gICAgICAgIGlmIChyZXRyaWVzUmVtYWluaW5nID49IDApIHJlc29sdmUoKTtcbiAgICAgIH0pO1xuXG4gICAgICB0aW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24oKSB7IHJldHJ5KCk7IH0sIHJldHJ5SW50ZXJ2YWwpO1xuXG4gICAgICBzb2NrZXQub24oJ2Vycm9yJywgZnVuY3Rpb24oZXJyKSB7XG4gICAgICAgIGNsZWFyVGltZXJBbmREZXN0cm95U29ja2V0KCk7XG4gICAgICAgIHNldFRpbWVvdXQocmV0cnksIHJldHJ5SW50ZXJ2YWwpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdHJ5VG9Db25uZWN0KCk7XG4gIH0pO1xufVxuXG4vKipcbiAqIEZ1bmN0aW9uIHRoYXQgaW50ZXJjZXB0cyBhbmQgcmV3cml0ZXMgSFRUUCByZXNwb25zZXMuXG4gKi9cbmV4cG9ydCB0eXBlIEludGVyY2VwdG9yID0gKG06IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UpID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuXG4vKipcbiAqIEFuIGludGVyY2VwdG9yIHRoYXQgZG9lcyBub3RoaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9wSW50ZXJjZXB0b3IobTogSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZSk6IHZvaWQge31cblxuLyoqXG4gKiBUaGUgY29yZSBIVFRQIHJlc3BvbnNlLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEhUVFBSZXNwb25zZSB7XG4gIHN0YXR1c0NvZGU6IG51bWJlcixcbiAgaGVhZGVyczoge1tuYW1lOiBzdHJpbmddOiBzdHJpbmd9O1xuICBib2R5OiBCdWZmZXI7XG59XG5cbi8qKlxuICogTWV0YWRhdGEgYXNzb2NpYXRlZCB3aXRoIGEgcmVxdWVzdC9yZXNwb25zZSBwYWlyLlxuICovXG5pbnRlcmZhY2UgSFRUUE1lc3NhZ2VNZXRhZGF0YSB7XG4gIHJlcXVlc3Q6IEhUVFBSZXF1ZXN0TWV0YWRhdGE7XG4gIHJlc3BvbnNlOiBIVFRQUmVzcG9uc2VNZXRhZGF0YTtcbn1cblxuLyoqXG4gKiBNZXRhZGF0YSBhc3NvY2lhdGVkIHdpdGggYW4gSFRUUCByZXF1ZXN0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEhUVFBSZXF1ZXN0TWV0YWRhdGEge1xuICAvLyBHRVQsIERFTEVURSwgUE9TVCwgIGV0Yy5cbiAgbWV0aG9kOiBzdHJpbmc7XG4gIC8vIFRhcmdldCBVUkwgZm9yIHRoZSByZXF1ZXN0LlxuICB1cmw6IHN0cmluZztcbiAgLy8gVGhlIHNldCBvZiBoZWFkZXJzIGZyb20gdGhlIHJlcXVlc3QsIGFzIGtleS12YWx1ZSBwYWlycy5cbiAgLy8gU2luY2UgaGVhZGVyIGZpZWxkcyBtYXkgYmUgcmVwZWF0ZWQsIHRoaXMgYXJyYXkgbWF5IGNvbnRhaW4gbXVsdGlwbGUgZW50cmllcyBmb3IgdGhlIHNhbWUga2V5LlxuICBoZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW107XG59XG5cbi8qKlxuICogTWV0YWRhdGEgYXNzb2NpYXRlZCB3aXRoIGFuIEhUVFAgcmVzcG9uc2UuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSFRUUFJlc3BvbnNlTWV0YWRhdGEge1xuICAvLyBUaGUgbnVtZXJpY2FsIHN0YXR1cyBjb2RlLlxuICBzdGF0dXNfY29kZTogbnVtYmVyO1xuICAvLyBUaGUgc2V0IG9mIGhlYWRlcnMgZnJvbSB0aGUgcmVzcG9uc2UsIGFzIGtleS12YWx1ZSBwYWlycy5cbiAgLy8gU2luY2UgaGVhZGVyIGZpZWxkcyBtYXkgYmUgcmVwZWF0ZWQsIHRoaXMgYXJyYXkgbWF5IGNvbnRhaW4gbXVsdGlwbGUgZW50cmllcyBmb3IgdGhlIHNhbWUga2V5LlxuICBoZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW107XG59XG5cbi8qKlxuICogQWJzdHJhY3QgY2xhc3MgdGhhdCByZXByZXNlbnRzIEhUVFAgaGVhZGVycy5cbiAqL1xuZXhwb3J0IGFic3RyYWN0IGNsYXNzIEFic3RyYWN0SFRUUEhlYWRlcnMge1xuICBwcml2YXRlIF9oZWFkZXJzOiBbc3RyaW5nLCBzdHJpbmddW107XG4gIC8vIFRoZSByYXcgaGVhZGVycywgYXMgYSBzZXF1ZW5jZSBvZiBrZXkvdmFsdWUgcGFpcnMuXG4gIC8vIFNpbmNlIGhlYWRlciBmaWVsZHMgbWF5IGJlIHJlcGVhdGVkLCB0aGlzIGFycmF5IG1heSBjb250YWluIG11bHRpcGxlIGVudHJpZXMgZm9yIHRoZSBzYW1lIGtleS5cbiAgcHVibGljIGdldCBoZWFkZXJzKCk6IFtzdHJpbmcsIHN0cmluZ11bXSB7XG4gICAgcmV0dXJuIHRoaXMuX2hlYWRlcnM7XG4gIH1cbiAgY29uc3RydWN0b3IoaGVhZGVyczogW3N0cmluZywgc3RyaW5nXVtdKSB7XG4gICAgdGhpcy5faGVhZGVycyA9IGhlYWRlcnM7XG4gIH1cblxuICBwcml2YXRlIF9pbmRleE9mSGVhZGVyKG5hbWU6IHN0cmluZyk6IG51bWJlciB7XG4gICAgY29uc3QgaGVhZGVycyA9IHRoaXMuaGVhZGVycztcbiAgICBjb25zdCBsZW4gPSBoZWFkZXJzLmxlbmd0aDtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICBpZiAoaGVhZGVyc1tpXVswXS50b0xvd2VyQ2FzZSgpID09PSBuYW1lKSB7XG4gICAgICAgIHJldHVybiBpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gLTE7XG4gIH1cblxuICAvKipcbiAgICogR2V0IHRoZSB2YWx1ZSBvZiB0aGUgZ2l2ZW4gaGVhZGVyIGZpZWxkLlxuICAgKiBJZiB0aGVyZSBhcmUgbXVsdGlwbGUgZmllbGRzIHdpdGggdGhhdCBuYW1lLCB0aGlzIG9ubHkgcmV0dXJucyB0aGUgZmlyc3QgZmllbGQncyB2YWx1ZSFcbiAgICogQHBhcmFtIG5hbWUgTmFtZSBvZiB0aGUgaGVhZGVyIGZpZWxkXG4gICAqL1xuICBwdWJsaWMgZ2V0SGVhZGVyKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gICAgY29uc3QgaW5kZXggPSB0aGlzLl9pbmRleE9mSGVhZGVyKG5hbWUudG9Mb3dlckNhc2UoKSk7XG4gICAgaWYgKGluZGV4ICE9PSAtMSkge1xuICAgICAgcmV0dXJuIHRoaXMuaGVhZGVyc1tpbmRleF1bMV07XG4gICAgfVxuICAgIHJldHVybiAnJztcbiAgfVxuXG4gIC8qKlxuICAgKiBTZXQgdGhlIHZhbHVlIG9mIHRoZSBnaXZlbiBoZWFkZXIgZmllbGQuIEFzc3VtZXMgdGhhdCB0aGVyZSBpcyBvbmx5IG9uZSBmaWVsZCB3aXRoIHRoZSBnaXZlbiBuYW1lLlxuICAgKiBJZiB0aGUgZmllbGQgZG9lcyBub3QgZXhpc3QsIGl0IGFkZHMgYSBuZXcgZmllbGQgd2l0aCB0aGUgbmFtZSBhbmQgdmFsdWUuXG4gICAqIEBwYXJhbSBuYW1lIE5hbWUgb2YgdGhlIGZpZWxkLlxuICAgKiBAcGFyYW0gdmFsdWUgTmV3IHZhbHVlLlxuICAgKi9cbiAgcHVibGljIHNldEhlYWRlcihuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBpbmRleCA9IHRoaXMuX2luZGV4T2ZIZWFkZXIobmFtZS50b0xvd2VyQ2FzZSgpKTtcbiAgICBpZiAoaW5kZXggIT09IC0xKSB7XG4gICAgICB0aGlzLmhlYWRlcnNbaW5kZXhdWzFdID0gdmFsdWU7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuaGVhZGVycy5wdXNoKFtuYW1lLCB2YWx1ZV0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmVzIHRoZSBoZWFkZXIgZmllbGQgd2l0aCB0aGUgZ2l2ZW4gbmFtZS4gQXNzdW1lcyB0aGF0IHRoZXJlIGlzIG9ubHkgb25lIGZpZWxkIHdpdGggdGhlIGdpdmVuIG5hbWUuXG4gICAqIERvZXMgbm90aGluZyBpZiBmaWVsZCBkb2VzIG5vdCBleGlzdC5cbiAgICogQHBhcmFtIG5hbWUgTmFtZSBvZiB0aGUgZmllbGQuXG4gICAqL1xuICBwdWJsaWMgcmVtb3ZlSGVhZGVyKG5hbWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5faW5kZXhPZkhlYWRlcihuYW1lLnRvTG93ZXJDYXNlKCkpO1xuICAgIGlmIChpbmRleCAhPT0gLTEpIHtcbiAgICAgIHRoaXMuaGVhZGVycy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZW1vdmVzIGFsbCBoZWFkZXIgZmllbGRzLlxuICAgKi9cbiAgcHVibGljIGNsZWFySGVhZGVycygpOiB2b2lkIHtcbiAgICB0aGlzLl9oZWFkZXJzID0gW107XG4gIH1cbn1cblxuLyoqXG4gKiBSZXByZXNlbnRzIGEgTUlUTS1lZCBIVFRQIHJlc3BvbnNlIGZyb20gYSBzZXJ2ZXIuXG4gKi9cbmV4cG9ydCBjbGFzcyBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZSBleHRlbmRzIEFic3RyYWN0SFRUUEhlYWRlcnMge1xuICAvLyBUaGUgc3RhdHVzIGNvZGUgb2YgdGhlIEhUVFAgcmVzcG9uc2UuXG4gIHB1YmxpYyBzdGF0dXNDb2RlOiBudW1iZXI7XG5cbiAgY29uc3RydWN0b3IobWV0YWRhdGE6IEhUVFBSZXNwb25zZU1ldGFkYXRhKSB7XG4gICAgc3VwZXIobWV0YWRhdGEuaGVhZGVycyk7XG4gICAgdGhpcy5zdGF0dXNDb2RlID0gbWV0YWRhdGEuc3RhdHVzX2NvZGU7XG4gICAgLy8gV2UgZG9uJ3Qgc3VwcG9ydCBjaHVua2VkIHRyYW5zZmVycy4gVGhlIHByb3h5IGFscmVhZHkgZGUtY2h1bmtzIGl0IGZvciB1cy5cbiAgICB0aGlzLnJlbW92ZUhlYWRlcigndHJhbnNmZXItZW5jb2RpbmcnKTtcbiAgICAvLyBNSVRNUHJveHkgZGVjb2RlcyB0aGUgZGF0YSBmb3IgdXMuXG4gICAgdGhpcy5yZW1vdmVIZWFkZXIoJ2NvbnRlbnQtZW5jb2RpbmcnKTtcbiAgICAvLyBDU1AgaXMgYmFkIVxuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCdjb250ZW50LXNlY3VyaXR5LXBvbGljeScpO1xuICAgIHRoaXMucmVtb3ZlSGVhZGVyKCd4LXdlYmtpdC1jc3AnKTtcbiAgICB0aGlzLnJlbW92ZUhlYWRlcigneC1jb250ZW50LXNlY3VyaXR5LXBvbGljeScpO1xuICB9XG5cbiAgcHVibGljIHRvSlNPTigpOiBIVFRQUmVzcG9uc2VNZXRhZGF0YSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXR1c19jb2RlOiB0aGlzLnN0YXR1c0NvZGUsXG4gICAgICBoZWFkZXJzOiB0aGlzLmhlYWRlcnNcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUmVwcmVzZW50cyBhbiBpbnRlcmNlcHRlZCBIVFRQIHJlcXVlc3QgZnJvbSBhIGNsaWVudC5cbiAqL1xuZXhwb3J0IGNsYXNzIEludGVyY2VwdGVkSFRUUFJlcXVlc3QgZXh0ZW5kcyBBYnN0cmFjdEhUVFBIZWFkZXJzIHtcbiAgLy8gSFRUUCBtZXRob2QgKEdFVC9ERUxFVEUvZXRjKVxuICBwdWJsaWMgbWV0aG9kOiBzdHJpbmc7XG4gIC8vIFRoZSBVUkwgYXMgYSBzdHJpbmcuXG4gIHB1YmxpYyByYXdVcmw6IHN0cmluZztcbiAgLy8gVGhlIFVSTCBhcyBhIFVSTCBvYmplY3QuXG4gIHB1YmxpYyB1cmw6IFVybDtcblxuICBjb25zdHJ1Y3RvcihtZXRhZGF0YTogSFRUUFJlcXVlc3RNZXRhZGF0YSkge1xuICAgIHN1cGVyKG1ldGFkYXRhLmhlYWRlcnMpO1xuICAgIHRoaXMubWV0aG9kID0gbWV0YWRhdGEubWV0aG9kLnRvTG93ZXJDYXNlKCk7XG4gICAgdGhpcy5yYXdVcmwgPSBtZXRhZGF0YS51cmw7XG4gICAgdGhpcy51cmwgPSBwYXJzZVVSTCh0aGlzLnJhd1VybCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZXByZXNlbnRzIGFuIGludGVyY2VwdGVkIEhUVFAgcmVxdWVzdC9yZXNwb25zZSBwYWlyLlxuICovXG5leHBvcnQgY2xhc3MgSW50ZXJjZXB0ZWRIVFRQTWVzc2FnZSB7XG4gIC8qKlxuICAgKiBVbnBhY2sgZnJvbSBhIEJ1ZmZlciByZWNlaXZlZCBmcm9tIE1JVE1Qcm94eS5cbiAgICogQHBhcmFtIGJcbiAgICovXG4gIHB1YmxpYyBzdGF0aWMgRnJvbUJ1ZmZlcihiOiBCdWZmZXIpOiBJbnRlcmNlcHRlZEhUVFBNZXNzYWdlIHtcbiAgICBjb25zdCBtZXRhZGF0YVNpemUgPSBiLnJlYWRJbnQzMkxFKDApO1xuICAgIGNvbnN0IHJlcXVlc3RTaXplID0gYi5yZWFkSW50MzJMRSg0KTtcbiAgICBjb25zdCByZXNwb25zZVNpemUgPSBiLnJlYWRJbnQzMkxFKDgpO1xuICAgIGNvbnN0IG1ldGFkYXRhOiBIVFRQTWVzc2FnZU1ldGFkYXRhID0gSlNPTi5wYXJzZShiLnRvU3RyaW5nKFwidXRmOFwiLCAxMiwgMTIgKyBtZXRhZGF0YVNpemUpKTtcbiAgICByZXR1cm4gbmV3IEludGVyY2VwdGVkSFRUUE1lc3NhZ2UoXG4gICAgICBuZXcgSW50ZXJjZXB0ZWRIVFRQUmVxdWVzdChtZXRhZGF0YS5yZXF1ZXN0KSxcbiAgICAgIG5ldyBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZShtZXRhZGF0YS5yZXNwb25zZSksXG4gICAgICBiLnNsaWNlKDEyICsgbWV0YWRhdGFTaXplLCAxMiArIG1ldGFkYXRhU2l6ZSArIHJlcXVlc3RTaXplKSxcbiAgICAgIGIuc2xpY2UoMTIgKyBtZXRhZGF0YVNpemUgKyByZXF1ZXN0U2l6ZSwgMTIgKyBtZXRhZGF0YVNpemUgKyByZXF1ZXN0U2l6ZSArIHJlc3BvbnNlU2l6ZSlcbiAgICApO1xuICB9XG5cbiAgcHVibGljIHJlYWRvbmx5IHJlcXVlc3Q6IEludGVyY2VwdGVkSFRUUFJlcXVlc3Q7XG4gIHB1YmxpYyByZWFkb25seSByZXNwb25zZTogSW50ZXJjZXB0ZWRIVFRQUmVzcG9uc2U7XG4gIC8vIFRoZSBib2R5IG9mIHRoZSBIVFRQIHJlcXVlc3QuXG4gIHB1YmxpYyByZWFkb25seSByZXF1ZXN0Qm9keTogQnVmZmVyO1xuICAvLyBUaGUgYm9keSBvZiB0aGUgSFRUUCByZXNwb25zZS4gUmVhZC1vbmx5OyBjaGFuZ2UgdGhlIHJlc3BvbnNlIGJvZHkgdmlhIHNldFJlc3BvbnNlQm9keS5cbiAgcHVibGljIGdldCByZXNwb25zZUJvZHkoKTogQnVmZmVyIHtcbiAgICByZXR1cm4gdGhpcy5fcmVzcG9uc2VCb2R5O1xuICB9XG4gIHByaXZhdGUgX3Jlc3BvbnNlQm9keTogQnVmZmVyO1xuICBwcml2YXRlIGNvbnN0cnVjdG9yKHJlcXVlc3Q6IEludGVyY2VwdGVkSFRUUFJlcXVlc3QsIHJlc3BvbnNlOiBJbnRlcmNlcHRlZEhUVFBSZXNwb25zZSwgcmVxdWVzdEJvZHk6IEJ1ZmZlciwgcmVzcG9uc2VCb2R5OiBCdWZmZXIpIHtcbiAgICB0aGlzLnJlcXVlc3QgPSByZXF1ZXN0O1xuICAgIHRoaXMucmVzcG9uc2UgPSByZXNwb25zZTtcbiAgICB0aGlzLnJlcXVlc3RCb2R5ID0gcmVxdWVzdEJvZHk7XG4gICAgdGhpcy5fcmVzcG9uc2VCb2R5ID0gcmVzcG9uc2VCb2R5O1xuICB9XG5cbiAgLyoqXG4gICAqIENoYW5nZXMgdGhlIGJvZHkgb2YgdGhlIEhUVFAgcmVzcG9uc2UuIEFwcHJvcHJpYXRlbHkgdXBkYXRlcyBjb250ZW50LWxlbmd0aC5cbiAgICogQHBhcmFtIGIgVGhlIG5ldyBib2R5IGNvbnRlbnRzLlxuICAgKi9cbiAgcHVibGljIHNldFJlc3BvbnNlQm9keShiOiBCdWZmZXIpIHtcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkgPSBiO1xuICAgIC8vIFVwZGF0ZSBjb250ZW50LWxlbmd0aC5cbiAgICB0aGlzLnJlc3BvbnNlLnNldEhlYWRlcignY29udGVudC1sZW5ndGgnLCBgJHtiLmxlbmd0aH1gKTtcbiAgICAvLyBUT0RPOiBDb250ZW50LWVuY29kaW5nP1xuICB9XG4gIFxuICAvKipcbiAgICogQ2hhbmdlcyB0aGUgc3RhdHVzIGNvZGUgb2YgdGhlIEhUVFAgcmVzcG9uc2UuXG4gICAqIEBwYXJhbSBjb2RlIFRoZSBuZXcgc3RhdHVzIGNvZGUuXG4gICAqL1xuICBwdWJsaWMgc2V0U3RhdHVzQ29kZShjb2RlOiBudW1iZXIpIHtcbiAgICB0aGlzLnJlc3BvbnNlLnN0YXR1c0NvZGUgPSBjb2RlO1xuICB9XG5cbiAgLyoqXG4gICAqIFBhY2sgaW50byBhIGJ1ZmZlciBmb3IgdHJhbnNtaXNzaW9uIHRvIE1JVE1Qcm94eS5cbiAgICovXG4gIHB1YmxpYyB0b0J1ZmZlcigpOiBCdWZmZXIge1xuICAgIGNvbnN0IG1ldGFkYXRhID0gQnVmZmVyLmZyb20oSlNPTi5zdHJpbmdpZnkodGhpcy5yZXNwb25zZSksICd1dGY4Jyk7XG4gICAgY29uc3QgbWV0YWRhdGFMZW5ndGggPSBtZXRhZGF0YS5sZW5ndGg7XG4gICAgY29uc3QgcmVzcG9uc2VMZW5ndGggPSB0aGlzLl9yZXNwb25zZUJvZHkubGVuZ3RoXG4gICAgY29uc3QgcnYgPSBCdWZmZXIuYWxsb2MoOCArIG1ldGFkYXRhTGVuZ3RoICsgcmVzcG9uc2VMZW5ndGgpO1xuICAgIHJ2LndyaXRlSW50MzJMRShtZXRhZGF0YUxlbmd0aCwgMCk7XG4gICAgcnYud3JpdGVJbnQzMkxFKHJlc3BvbnNlTGVuZ3RoLCA0KTtcbiAgICBtZXRhZGF0YS5jb3B5KHJ2LCA4KTtcbiAgICB0aGlzLl9yZXNwb25zZUJvZHkuY29weShydiwgOCArIG1ldGFkYXRhTGVuZ3RoKTtcbiAgICByZXR1cm4gcnY7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFN0YXNoZWRJdGVtIHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHVibGljIHJlYWRvbmx5IHJhd1VybDogc3RyaW5nLFxuICAgIHB1YmxpYyByZWFkb25seSBtaW1lVHlwZTogc3RyaW5nLFxuICAgIHB1YmxpYyByZWFkb25seSBkYXRhOiBCdWZmZXIpIHt9XG5cbiAgcHVibGljIGdldCBzaG9ydE1pbWVUeXBlKCk6IHN0cmluZyB7XG4gICAgbGV0IG1pbWUgPSB0aGlzLm1pbWVUeXBlLnRvTG93ZXJDYXNlKCk7XG4gICAgaWYgKG1pbWUuaW5kZXhPZihcIjtcIikgIT09IC0xKSB7XG4gICAgICBtaW1lID0gbWltZS5zbGljZSgwLCBtaW1lLmluZGV4T2YoXCI7XCIpKTtcbiAgICB9XG4gICAgcmV0dXJuIG1pbWU7XG4gIH1cblxuICBwdWJsaWMgZ2V0IGlzSHRtbCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5zaG9ydE1pbWVUeXBlID09PSBcInRleHQvaHRtbFwiO1xuICB9XG5cbiAgcHVibGljIGdldCBpc0phdmFTY3JpcHQoKTogYm9vbGVhbiB7XG4gICAgc3dpdGNoKHRoaXMuc2hvcnRNaW1lVHlwZSkge1xuICAgICAgY2FzZSAndGV4dC9qYXZhc2NyaXB0JzpcbiAgICAgIGNhc2UgJ2FwcGxpY2F0aW9uL2phdmFzY3JpcHQnOlxuICAgICAgY2FzZSAndGV4dC94LWphdmFzY3JpcHQnOlxuICAgICAgY2FzZSAnYXBwbGljYXRpb24veC1qYXZhc2NyaXB0JzpcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRTdGFzaEZpbHRlcih1cmw6IHN0cmluZywgaXRlbTogU3Rhc2hlZEl0ZW0pOiBib29sZWFuIHtcbiAgcmV0dXJuIGl0ZW0uaXNKYXZhU2NyaXB0IHx8IGl0ZW0uaXNIdG1sO1xufVxuXG4vKipcbiAqIENsYXNzIHRoYXQgbGF1bmNoZXMgTUlUTSBwcm94eSBhbmQgdGFsa3MgdG8gaXQgdmlhIFdlYlNvY2tldHMuXG4gKi9cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIE1JVE1Qcm94eSB7XG4gIHByaXZhdGUgc3RhdGljIF9hY3RpdmVQcm9jZXNzZXM6IENoaWxkUHJvY2Vzc1tdID0gW107XG5cbiAgLyoqXG4gICAqIENyZWF0ZXMgYSBuZXcgTUlUTVByb3h5IGluc3RhbmNlLlxuICAgKiBAcGFyYW0gY2IgQ2FsbGVkIHdpdGggaW50ZXJjZXB0ZWQgSFRUUCByZXF1ZXN0cyAvIHJlc3BvbnNlcy5cbiAgICogQHBhcmFtIGludGVyY2VwdFBhdGhzIExpc3Qgb2YgcGF0aHMgdG8gY29tcGxldGVseSBpbnRlcmNlcHQgd2l0aG91dCBzZW5kaW5nIHRvIHRoZSBzZXJ2ZXIgKGUuZy4gWycvZXZhbCddKVxuICAgKiBAcGFyYW0gcXVpZXQgSWYgdHJ1ZSwgZG8gbm90IHByaW50IGRlYnVnZ2luZyBtZXNzYWdlcyAoZGVmYXVsdHMgdG8gJ3RydWUnKS5cbiAgICogQHBhcmFtIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgSWYgdHJ1ZSwgb25seSBpbnRlcmNlcHQgdGV4dCBmaWxlcyAoSmF2YVNjcmlwdC9IVE1ML0NTUy9ldGMsIGFuZCBpZ25vcmUgbWVkaWEgZmlsZXMpLlxuICAgKi9cbiAgcHVibGljIHN0YXRpYyBhc3luYyBDcmVhdGUoY2I6IEludGVyY2VwdG9yID0gbm9wSW50ZXJjZXB0b3IsIGludGVyY2VwdFBhdGhzOiBzdHJpbmdbXSA9IFtdLCBxdWlldDogYm9vbGVhbiA9IHRydWUsIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXMgPSBmYWxzZSwgaWdub3JlSG9zdHM6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTxNSVRNUHJveHk+IHtcbiAgICAvLyBDb25zdHJ1Y3QgV2ViU29ja2V0IHNlcnZlciwgYW5kIHdhaXQgZm9yIGl0IHRvIGJlZ2luIGxpc3RlbmluZy5cbiAgICBjb25zdCB3c3MgPSBuZXcgV2ViU29ja2V0U2VydmVyKHsgcG9ydDogODc2NSB9KTtcbiAgICBjb25zdCBwcm94eUNvbm5lY3RlZCA9IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIHdzcy5vbmNlKCdjb25uZWN0aW9uJywgKCkgPT4ge1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgICBjb25zdCBtcCA9IG5ldyBNSVRNUHJveHkoY2IsIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXMpO1xuICAgIC8vIFNldCB1cCBXU1MgY2FsbGJhY2tzIGJlZm9yZSBNSVRNUHJveHkgY29ubmVjdHMuXG4gICAgbXAuX2luaXRpYWxpemVXU1Mod3NzKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICB3c3Mub25jZSgnbGlzdGVuaW5nJywgKCkgPT4ge1xuICAgICAgICB3c3MucmVtb3ZlTGlzdGVuZXIoJ2Vycm9yJywgcmVqZWN0KTtcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfSk7XG4gICAgICB3c3Mub25jZSgnZXJyb3InLCByZWplY3QpO1xuICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHdhaXRGb3JQb3J0KDgwODAsIDEpO1xuICAgICAgICBpZiAoIXF1aWV0KSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYE1JVE1Qcm94eSBhbHJlYWR5IHJ1bm5pbmcuYCk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKCFxdWlldCkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBNSVRNUHJveHkgbm90IHJ1bm5pbmc7IHN0YXJ0aW5nIHVwIG1pdG1wcm94eS5gKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBTdGFydCB1cCBNSVRNIHByb2Nlc3MuXG4gICAgICAgIC8vIC0tYW50aWNhY2hlIG1lYW5zIHRvIGRpc2FibGUgY2FjaGluZywgd2hpY2ggZ2V0cyBpbiB0aGUgd2F5IG9mIHRyYW5zcGFyZW50bHkgcmV3cml0aW5nIGNvbnRlbnQuXG4gICAgICAgIGNvbnN0IHNjcmlwdEFyZ3MgPSBpbnRlcmNlcHRQYXRocy5sZW5ndGggPiAwID8gW1wiLS1zZXRcIiwgYGludGVyY2VwdD0ke2ludGVyY2VwdFBhdGhzLmpvaW4oXCIsXCIpfWBdIDogW107XG4gICAgICAgIHNjcmlwdEFyZ3MucHVzaChcIi0tc2V0XCIsIGBvbmx5SW50ZXJjZXB0VGV4dEZpbGVzPSR7b25seUludGVyY2VwdFRleHRGaWxlc31gKTtcbiAgICAgICAgaWYgKGlnbm9yZUhvc3RzKSB7XG4gICAgICAgICAgc2NyaXB0QXJncy5wdXNoKGAtLWlnbm9yZS1ob3N0c2AsIGlnbm9yZUhvc3RzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSBbXCItLWFudGljYWNoZVwiLCBcIi1zXCIsIHJlc29sdmUoX19kaXJuYW1lLCBgLi4vc2NyaXB0cy9wcm94eS5weWApXS5jb25jYXQoc2NyaXB0QXJncyk7XG4gICAgICAgIGlmIChxdWlldCkge1xuICAgICAgICAgIG9wdGlvbnMucHVzaCgnLXEnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgLy8gYWxsb3cgc2VsZi1zaWduZWQgU1NMIGNlcnRpZmljYXRlc1xuICAgICAgICBvcHRpb25zLnB1c2goXCItLXNzbC1pbnNlY3VyZVwiKTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IG1pdG1Qcm9jZXNzID0gc3Bhd24oXCJtaXRtZHVtcFwiLCBvcHRpb25zLCB7XG4gICAgICAgICAgc3RkaW86ICdpbmhlcml0J1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgbWl0bVByb3h5RXhpdGVkID0gbmV3IFByb21pc2U8dm9pZD4oKF8sIHJlamVjdCkgPT4ge1xuICAgICAgICAgIG1pdG1Qcm9jZXNzLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcbiAgICAgICAgICBtaXRtUHJvY2Vzcy5vbmNlKCdleGl0JywgcmVqZWN0KTtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmIChNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5wdXNoKG1pdG1Qcm9jZXNzKSA9PT0gMSkge1xuICAgICAgICAgIHByb2Nlc3Mub24oJ1NJR0lOVCcsIE1JVE1Qcm94eS5fY2xlYW51cCk7XG4gICAgICAgICAgcHJvY2Vzcy5vbignZXhpdCcsIE1JVE1Qcm94eS5fY2xlYW51cCk7XG4gICAgICAgIH1cbiAgICAgICAgbXAuX2luaXRpYWxpemVNSVRNUHJveHkobWl0bVByb2Nlc3MpO1xuICAgICAgICAvLyBXYWl0IGZvciBwb3J0IDgwODAgdG8gY29tZSBvbmxpbmUuXG4gICAgICAgIGNvbnN0IHdhaXRpbmdGb3JQb3J0ID0gd2FpdEZvclBvcnQoODA4MCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgLy8gRmFpbHMgaWYgbWl0bXByb3h5IGV4aXRzIGJlZm9yZSBwb3J0IGJlY29tZXMgYXZhaWxhYmxlLlxuICAgICAgICAgIGF3YWl0IFByb21pc2UucmFjZShbbWl0bVByb3h5RXhpdGVkLCB3YWl0aW5nRm9yUG9ydF0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgaWYgKGUgJiYgdHlwZW9mKGUpID09PSAnb2JqZWN0JyAmJiBlLmNvZGUgPT09IFwiRU5PRU5UXCIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgbWl0bWR1bXAsIHdoaWNoIGlzIGFuIGV4ZWN1dGFibGUgdGhhdCBzaGlwcyB3aXRoIG1pdG1wcm94eSwgaXMgbm90IG9uIHlvdXIgUEFUSC4gUGxlYXNlIGVuc3VyZSB0aGF0IHlvdSBjYW4gcnVuIG1pdG1kdW1wIC0tdmVyc2lvbiBzdWNjZXNzZnVsbHkgZnJvbSB5b3VyIGNvbW1hbmQgbGluZS5gKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuYWJsZSB0byBzdGFydCBtaXRtcHJveHk6ICR7ZX1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGF3YWl0IHByb3h5Q29ubmVjdGVkO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlPGFueT4oKHJlc29sdmUpID0+IHdzcy5jbG9zZShyZXNvbHZlKSk7XG4gICAgICB0aHJvdyBlO1xuICAgIH1cblxuICAgIHJldHVybiBtcDtcbiAgfVxuXG4gIHByaXZhdGUgc3RhdGljIF9jbGVhbnVwQ2FsbGVkID0gZmFsc2U7XG4gIHByaXZhdGUgc3RhdGljIF9jbGVhbnVwKCk6IHZvaWQge1xuICAgIGlmIChNSVRNUHJveHkuX2NsZWFudXBDYWxsZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgTUlUTVByb3h5Ll9jbGVhbnVwQ2FsbGVkID0gdHJ1ZTtcbiAgICBNSVRNUHJveHkuX2FjdGl2ZVByb2Nlc3Nlcy5mb3JFYWNoKChwKSA9PiB7XG4gICAgICBwLmtpbGwoJ1NJR0tJTEwnKTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX3N0YXNoRW5hYmxlZDogYm9vbGVhbiA9IGZhbHNlO1xuICAvLyBUb2dnbGUgd2hldGhlciBvciBub3QgbWl0bXByb3h5LW5vZGUgc3Rhc2hlcyBtb2RpZmllZCBzZXJ2ZXIgcmVzcG9uc2VzLlxuICAvLyAqKk5vdCB1c2VkIGZvciBwZXJmb3JtYW5jZSoqLCBidXQgZW5hYmxlcyBOb2RlLmpzIGNvZGUgdG8gZmV0Y2ggcHJldmlvdXMgc2VydmVyIHJlc3BvbnNlcyBmcm9tIHRoZSBwcm94eS5cbiAgcHVibGljIGdldCBzdGFzaEVuYWJsZWQoKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuX3N0YXNoRW5hYmxlZDtcbiAgfVxuICBwdWJsaWMgc2V0IHN0YXNoRW5hYmxlZCh2OiBib29sZWFuKSB7XG4gICAgaWYgKCF2KSB7XG4gICAgICB0aGlzLl9zdGFzaC5jbGVhcigpO1xuICAgIH1cbiAgICB0aGlzLl9zdGFzaEVuYWJsZWQgPSB2O1xuICB9XG4gIHByaXZhdGUgX21pdG1Qcm9jZXNzOiBDaGlsZFByb2Nlc3MgPSBudWxsO1xuICBwcml2YXRlIF9taXRtRXJyb3I6IEVycm9yID0gbnVsbDtcbiAgcHJpdmF0ZSBfd3NzOiBXZWJTb2NrZXRTZXJ2ZXIgPSBudWxsO1xuICBwdWJsaWMgY2I6IEludGVyY2VwdG9yO1xuICBwdWJsaWMgcmVhZG9ubHkgb25seUludGVyY2VwdFRleHRGaWxlczogYm9vbGVhbjtcbiAgcHJpdmF0ZSBfc3Rhc2ggPSBuZXcgTWFwPHN0cmluZywgU3Rhc2hlZEl0ZW0+KCk7XG4gIHByaXZhdGUgX3N0YXNoRmlsdGVyOiAodXJsOiBzdHJpbmcsIGl0ZW06IFN0YXNoZWRJdGVtKSA9PiBib29sZWFuID0gZGVmYXVsdFN0YXNoRmlsdGVyO1xuICBwdWJsaWMgZ2V0IHN0YXNoRmlsdGVyKCk6ICh1cmw6IHN0cmluZywgaXRlbTogU3Rhc2hlZEl0ZW0pID0+IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLl9zdGFzaEZpbHRlcjtcbiAgfVxuICBwdWJsaWMgc2V0IHN0YXNoRmlsdGVyKHZhbHVlOiAodXJsOiBzdHJpbmcsIGl0ZW06IFN0YXNoZWRJdGVtKSA9PiBib29sZWFuKSB7XG4gICAgaWYgKHR5cGVvZih2YWx1ZSkgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHRoaXMuX3N0YXNoRmlsdGVyID0gdmFsdWU7XG4gICAgfSBlbHNlIGlmICh2YWx1ZSA9PT0gbnVsbCkge1xuICAgICAgdGhpcy5fc3Rhc2hGaWx0ZXIgPSBkZWZhdWx0U3Rhc2hGaWx0ZXI7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBzdGFzaCBmaWx0ZXI6IEV4cGVjdGVkIGEgZnVuY3Rpb24uYCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjb25zdHJ1Y3RvcihjYjogSW50ZXJjZXB0b3IsIG9ubHlJbnRlcmNlcHRUZXh0RmlsZXM6IGJvb2xlYW4pIHtcbiAgICB0aGlzLmNiID0gY2I7XG4gICAgdGhpcy5vbmx5SW50ZXJjZXB0VGV4dEZpbGVzID0gb25seUludGVyY2VwdFRleHRGaWxlcztcbiAgfVxuXG4gIHByaXZhdGUgX2luaXRpYWxpemVXU1Mod3NzOiBXZWJTb2NrZXRTZXJ2ZXIpOiB2b2lkIHtcbiAgICB0aGlzLl93c3MgPSB3c3M7XG4gICAgdGhpcy5fd3NzLm9uKCdjb25uZWN0aW9uJywgKHdzKSA9PiB7XG4gICAgICB3cy5vbignZXJyb3InLCAoZSkgPT4ge1xuICAgICAgICBpZiAoKGUgYXMgYW55KS5jb2RlICE9PSBcIkVDT05OUkVTRVRcIikge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBXZWJTb2NrZXQgZXJyb3I6ICR7ZX1gKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICB3cy5vbignbWVzc2FnZScsIGFzeW5jIChtZXNzYWdlOiBCdWZmZXIpID0+IHtcbiAgICAgICAgY29uc3Qgb3JpZ2luYWwgPSBJbnRlcmNlcHRlZEhUVFBNZXNzYWdlLkZyb21CdWZmZXIobWVzc2FnZSk7XG4gICAgICAgIGNvbnN0IHJ2ID0gdGhpcy5jYihvcmlnaW5hbCk7XG4gICAgICAgIGlmIChydiAmJiB0eXBlb2YocnYpID09PSAnb2JqZWN0JyAmJiBydi50aGVuKSB7XG4gICAgICAgICAgYXdhaXQgcnY7XG4gICAgICAgIH1cbiAgICAgICAgLy8gUmVtb3ZlIHRyYW5zZmVyLWVuY29kaW5nLiBXZSBkb24ndCBzdXBwb3J0IGNodW5rZWQuXG4gICAgICAgIGlmICh0aGlzLl9zdGFzaEVuYWJsZWQpIHtcbiAgICAgICAgICBjb25zdCBpdGVtID0gbmV3IFN0YXNoZWRJdGVtKG9yaWdpbmFsLnJlcXVlc3QucmF3VXJsLCBvcmlnaW5hbC5yZXNwb25zZS5nZXRIZWFkZXIoJ2NvbnRlbnQtdHlwZScpLCBvcmlnaW5hbC5yZXNwb25zZUJvZHkpO1xuICAgICAgICAgIGlmICh0aGlzLl9zdGFzaEZpbHRlcihvcmlnaW5hbC5yZXF1ZXN0LnJhd1VybCwgaXRlbSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3N0YXNoLnNldChvcmlnaW5hbC5yZXF1ZXN0LnJhd1VybCwgaXRlbSk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHdzLnNlbmQob3JpZ2luYWwudG9CdWZmZXIoKSk7XG4gICAgICB9KTtcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgX2luaXRpYWxpemVNSVRNUHJveHkobWl0bVByb3h5OiBDaGlsZFByb2Nlc3MpOiB2b2lkIHtcbiAgICB0aGlzLl9taXRtUHJvY2VzcyA9IG1pdG1Qcm94eTtcbiAgICB0aGlzLl9taXRtUHJvY2Vzcy5vbignZXhpdCcsIChjb2RlLCBzaWduYWwpID0+IHtcbiAgICAgIGNvbnN0IGluZGV4ID0gTUlUTVByb3h5Ll9hY3RpdmVQcm9jZXNzZXMuaW5kZXhPZih0aGlzLl9taXRtUHJvY2Vzcyk7XG4gICAgICBpZiAoaW5kZXggIT09IC0xKSB7XG4gICAgICAgIE1JVE1Qcm94eS5fYWN0aXZlUHJvY2Vzc2VzLnNwbGljZShpbmRleCwgMSk7XG4gICAgICB9XG4gICAgICBpZiAoY29kZSAhPT0gbnVsbCkge1xuICAgICAgICBpZiAoY29kZSAhPT0gMCkge1xuICAgICAgICAgIHRoaXMuX21pdG1FcnJvciA9IG5ldyBFcnJvcihgUHJvY2VzcyBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0uYCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX21pdG1FcnJvciA9IG5ldyBFcnJvcihgUHJvY2VzcyBleGl0ZWQgZHVlIHRvIHNpZ25hbCAke3NpZ25hbH0uYCk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdGhpcy5fbWl0bVByb2Nlc3Mub24oJ2Vycm9yJywgKGVycikgPT4ge1xuICAgICAgdGhpcy5fbWl0bUVycm9yID0gZXJyO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHJpZXZlcyB0aGUgZ2l2ZW4gVVJMIGZyb20gdGhlIHN0YXNoLlxuICAgKiBAcGFyYW0gdXJsXG4gICAqL1xuICBwdWJsaWMgZ2V0RnJvbVN0YXNoKHVybDogc3RyaW5nKTogU3Rhc2hlZEl0ZW0ge1xuICAgIHJldHVybiB0aGlzLl9zdGFzaC5nZXQodXJsKTtcbiAgfVxuXG4gIHB1YmxpYyBmb3JFYWNoU3Rhc2hJdGVtKGNiOiAodmFsdWU6IFN0YXNoZWRJdGVtLCB1cmw6IHN0cmluZykgPT4gdm9pZCk6IHZvaWQge1xuICAgIHRoaXMuX3N0YXNoLmZvckVhY2goY2IpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlcXVlc3RzIHRoZSBnaXZlbiBVUkwgZnJvbSB0aGUgcHJveHkuXG4gICAqL1xuICBwdWJsaWMgYXN5bmMgcHJveHlHZXQodXJsU3RyaW5nOiBzdHJpbmcpOiBQcm9taXNlPEhUVFBSZXNwb25zZT4ge1xuICAgIGNvbnN0IHVybCA9IHBhcnNlVVJMKHVybFN0cmluZyk7XG4gICAgY29uc3QgZ2V0ID0gdXJsLnByb3RvY29sID09PSBcImh0dHA6XCIgPyBodHRwR2V0IDogaHR0cHNHZXQ7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPEhUVFBSZXNwb25zZT4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgcmVxID0gZ2V0KHtcbiAgICAgICAgdXJsOiB1cmxTdHJpbmcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICBob3N0OiB1cmwuaG9zdFxuICAgICAgICB9LFxuICAgICAgICBob3N0OiAnbG9jYWxob3N0JyxcbiAgICAgICAgcG9ydDogODA4MCxcbiAgICAgICAgcGF0aDogdXJsU3RyaW5nXG4gICAgICB9LCAocmVzKSA9PiB7XG4gICAgICAgIGNvbnN0IGRhdGEgPSBuZXcgQXJyYXk8QnVmZmVyPigpO1xuICAgICAgICByZXMub24oJ2RhdGEnLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgICAgIGRhdGEucHVzaChjaHVuayk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXMub24oJ2VuZCcsICgpID0+IHtcbiAgICAgICAgICBjb25zdCBkID0gQnVmZmVyLmNvbmNhdChkYXRhKTtcbiAgICAgICAgICByZXNvbHZlKHtcbiAgICAgICAgICAgIHN0YXR1c0NvZGU6IHJlcy5zdGF0dXNDb2RlLFxuICAgICAgICAgICAgaGVhZGVyczogcmVzLmhlYWRlcnMsXG4gICAgICAgICAgICBib2R5OiBkXG4gICAgICAgICAgfSBhcyBIVFRQUmVzcG9uc2UpO1xuICAgICAgICB9KTtcbiAgICAgICAgcmVzLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcbiAgICAgIH0pO1xuICAgICAgcmVxLm9uY2UoJ2Vycm9yJywgcmVqZWN0KTtcbiAgICB9KTtcbiAgfVxuXG4gIHB1YmxpYyBhc3luYyBzaHV0ZG93bigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgY2xvc2VXU1MgPSAoKSA9PiB7XG4gICAgICAgIHRoaXMuX3dzcy5jbG9zZSgoZXJyKSA9PiB7XG4gICAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgcmVqZWN0KGVycik7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgfTtcblxuICAgICAgaWYgKHRoaXMuX21pdG1Qcm9jZXNzICYmICF0aGlzLl9taXRtUHJvY2Vzcy5raWxsZWQpIHtcbiAgICAgICAgdGhpcy5fbWl0bVByb2Nlc3Mub25jZSgnZXhpdCcsIChjb2RlLCBzaWduYWwpID0+IHtcbiAgICAgICAgICBjbG9zZVdTUygpO1xuICAgICAgICB9KTtcbiAgICAgICAgdGhpcy5fbWl0bVByb2Nlc3Mua2lsbCgnU0lHVEVSTScpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2xvc2VXU1MoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufVxuIl19