"use strict"
var term;
var ws;
var connected = false;
var binary_state = 0;
var put_file_name = null;
var get_file_name = null;
var get_file_data = null;

function calculate_size(win) {
    var cols = Math.max(80, Math.min(150, (win.innerWidth - 280) / 7)) | 0;
    var rows = Math.max(24, Math.min(80, (win.innerHeight - 180) / 12)) | 0;
    return [cols, rows];
}
async function readAsDataURL(thing) {
  return new Promise(r => {
    const reader = new FileReader()
    reader.onload = () => r(reader.result)
    reader.readAsDataURL(thing)
  });
}
async function readAsArrayBuffer(thing) {
  return new Promise(r => {
    const reader = new FileReader()
    reader.onload = () => r(reader.result)
    reader.readAsArrayBuffer(thing)
  });
}

function pythonEscape(array) {
    if(typeof(array) == "string"){
	array = new TextEncoder("utf-8").encode(array);
    }
    let result = "'";
    for(let i = 0; i < array.length; i++){
	if(array[i] == 92){
	    result += "\\\\";
	} else if(array[i] == 39){
	    result += "\\'";
	} else if(array[i] >= 32 && array[i] <= 126){
	    result += String.fromCharCode(array[i]);
	} else {
	    result += "\\x" + (array[i]).toString(16).padStart(2, '0');
	}
    }
    return result + "'";
}
function unescapeLine(line){
    if(!(line.startsWith("b'") && line.endsWith("'") || line.startsWith("b\"") && line.endsWith("\""))){
	throw new Error(line);
    }
    line = line.substring(2, line.length-1);
    let out = new Uint8Array(line.length);
    let outPos = 0;
    for(let i = 0; i < line.length; i++){
	if(line.charAt(i) == "\\"){
	    if(i+1 >= line.length){
		throw new Error();
	    }
	    i++;
	    if(line.charAt(i) == "n"){
		out[outPos++] = 10;
	    }else if(line.charAt(i) == "r"){
		out[outPos++] = 13;
	    }else if(line.charAt(i) == "t"){
		out[outPos++] = 9;
	    }else if(line.charAt(i) == "\\"){
		out[outPos++] = 92;
	    }else if(line.charAt(i) == "'"){
		out[outPos++] = 39;
	    }else if(line.charAt(i) == "x"){
		if(i+2 >= line.length){
		    throw new Error();
		}
		out[outPos++] = parseInt(line.substr(i+1,2), 16);
		i += 2;
	    } else {
		throw new Error("Unrecognized escape: " + line.charAt(i));
	    }
	} else {
	    out[outPos++] = line.charCodeAt(i);
	}
    }
    return new Uint8Array(out.buffer, 0, outPos);
}


class MIP {
    constructor(node) {
	let mip = this;
	this.index = "https://micropython.org/pi/v2";
	this.rootNode = node;
	this.search = document.createElement("input");
	this.rootNode.appendChild(this.search);
	this.search.onfocus = (e) => this.load();
	this.search.oninput = (e) => this.load();
	this.body = document.createElement("div");
	this.body.style.maxHeight = "300px";
	this.body.style.overflowY = "scroll";
	this.rootNode.appendChild(this.body);

	this.selection = document.createElement("div");
	let install = document.createElement("button");
	install.appendChild(document.createTextNode("install"));
	install.onclick = async (e) => {
	    mip.installPackageManifest(await mip.getPackageManifest(mip.selectedPkg.pkg.name));
	};
	this.rootNode.appendChild(install)
	install.disabled = true;
	this.install = install;
	window.mip = this;
    }
    async fetchIndex() {
	return (await fetch(this.index + "/index.json")).json();
    }
    async getIndex() {
	if(this.indexCached){
	    return this.indexCached;
	}
	this.indexCached = this.fetchIndex();
	return this.indexCached;
    }
    
    rewrite_url(url, branch="HEAD") {
	if(url.startsWith("github:")){
	    let match = url.match(/^github:([^\/]*)\/([^\/]*)((?:\/.*)?)$/)
            url = "https://raw.githubusercontent.com/"
		+ match[1]
		+ "/"
		+ match[2]
		+ "/"
		+ branch
		+ match[3];
	}
	return url;
    }

    async load() {
	this.selectedPkg = undefined;
	let mip = this;
	this.body.textContent = "";
	for(let pkg of (await this.getIndex()).packages) {
	    if(pkg.name.indexOf(this.search.value) === -1) {
		continue;
	    }
	    let div = document.createElement("div");
	    div.pkg = pkg;
	    div.append(document.createTextNode(pkg.name));
	    div.onclick = (e) => {
		if(mip.selectedPkg !== undefined){
		    mip.selectedPkg.style.backgroundColor="";
		}
		mip.install.disabled = false;
		mip.install.textContent = "install " + pkg.name;
		mip.selectedPkg = div;
		div.style.backgroundColor="#8080ff80";
	    };
	    let version = document.createElement("span");
	    version.appendChild(document.createTextNode("@" + pkg.version));
	    version.setAttribute("class", "version");
	    div.appendChild(version);
	    div.title = pkg.description;
	    this.body.append(div);
	}
    }
    getInstallTarget(){
	if(this.installTarget) {
	    return this.installTarget;
	}
	this.installTarget = (async () => {
	    let res = (await executeInRawRepl("import sys; print('\\n'.join(p for p in sys.path if p.endswith('/lib')),end='')")).split("\n");
	    return res[0];
	})();
	return this.installTarget;
    }
    getMpyVersion() {
	if(this.mpyVersion) {
	    return this.mpyVersion;
	}
	this.mpyVersion = (async () => {
	    let res = (await executeInRawRepl("print(getattr(sys.implementation, '_mpy', 0) & 0xFF)")).trim();
	    if(res == "0") {
		return "py";
	    }
	    return res;
	})();
	return this.mpyVersion;
    }

    async exists(path) {
	let check = await executeInRawRepl("import os\ntry:\n  os.stat(" + pythonEscape(path) + ");print('exists')\nexcept:\n  print('missing');\n")
	return check.trim() == "exists";
    }
    async mkdirs(path) {
	if(path == "" || path == "/") {
	    return;
	}
	if(await this.exists(path)) {
	    return;
	}
	let index = path.lastIndexOf("/");
	let parent = path.substr(0, index);
	await this.mkdirs(parent);
	await executeInRawRepl("os.mkdir(" + pythonEscape(path) + ")")
    }

    async installPackageManifest(package_json){
	if(typeof(package_json) === "string"){
            let target = (await this.getInstallTarget()) + "/" + package_json.substr(package_json.lastIndexOf("/")+1);
	    console.log("Download " + package_json + " to " + target);
	    return;
	}
	for(let [target_path, short_hash] of package_json.hashes || []) {
            let target = (await this.getInstallTarget()) + "/" + target_path;
            let url = this.index + "/file/" + short_hash.substr(0,2) + "/" + short_hash;
	    let targetDir = target.substr(0, target.lastIndexOf("/"));
	    console.log("Download " + url + " to " + target);
	    await this.mkdirs(targetDir);
	    await writeFile(target, await (await fetch(url)).arrayBuffer());
	}
	for(let [target_path, url] of package_json.urls || []) {
            let target = (await this.getInstallTarget()) + "/" + target_path;
	    console.log("Download " + url + " to " + target);
	}
	for(let [dep, dep_version] of package_json.deps || []) {
	    console.log(dep + "@" + dep_version + " is dependency.");
	}
    }

    async getPackageManifest(pkg, version = "latest"){
	if(pkg.startsWith("http://")
             || pkg.startsWith("https://")
             || pkg.startsWith("github:")) {
            if(pkg.endsWith(".py") || pkg.endsWith(".mpy")){
		return pkg;
	    } else {
		if(!pkg.endsWith(".json")){
                    if(!pkg.endsWith("/")){
			pkg += "/"
		    }
                    pkg += "package.json"
		}
		return (await fetch(this.rewrite_url(pkg))).json();
	    }
	} else {
	    return (await fetch(this.index + "/package/" + (await this.getMpyVersion()) + "/"+ pkg + "/" + version + ".json")).json();
	}
    }
}
async function writeFile(path, data) {
    executeStatementsInRawRepl(async (execute) => {
	await execute("f=open(" + pythonEscape(path) + ",'wb')\nw=f.write");
	for(let i = 0; i < data.byteLength; i += 256 ) {
	    let len = Math.min(256, data.byteLength - i);
	    let stmt = pythonEscape(new Uint8Array(data, i, len));
	    await execute("w(" + stmt + ")");
	}
	await execute("f.close()");
    });
}

class RemoteDirectory {
    constructor(node, path, name) {
	let dir = this;
	this.node = node;
	this.path = path;
	this.label = document.createElement("span");
	if(this.path === "/") {
	    let image = document.createElement("img");
	    image.src = "https://raw.githubusercontent.com/micropython/micropython/813d559bc098eeaa1c6e0fa1deff92e666c0b458/logo/vector-logo-inkscape_master.svg";
	    image.style.height = "2em";
	    this.label.appendChild(image);
	}
	this.label.appendChild(document.createTextNode(name));
	this.node.appendChild(this.label);
	this.upload = document.createElement("span");
	this.upload.appendChild(document.createTextNode("+"));
	this.node.appendChild(this.upload);
	this.upload.onclick = function() {
	    let putfile = document.getElementById('put-file-select');
	    putfile.onchange = async function() {
		let f = putfile.files[0];
		let data = await readAsArrayBuffer(f);
		await writeFile(path + f.name, data);
	    };
	    putfile.click();
	};
	this.upload.ondragover = function(e) {
	    e.preventDefault();
	}
	this.upload.ondrop = function(e) {
	    console.log(path);
	    let entry = e.dataTransfer.items[0].webkitGetAsEntry();
	    if(path.startsWith("/remote")){
		theFs.mountpoints[path.substr(7) + entry.name] = new FileEntryFS(entry);
	    }
	    e.preventDefault();
	}
	this.body = document.createElement("div");
	this.body.style.paddingLeft = "5px";
	this.node.parentNode.insertBefore(this.body, this.node.nextSibling);
	this.label.onclick = async function() {
	    dir.body.textContent = "";
	    let listing = await ls(path);
	    for(let line of listing){
		let label = document.createElement("div");
		dir.body.appendChild(label);
		if(line[1] == 0x4000){
		    new RemoteDirectory(label, path+line[0]+"/", line[0])
		} else {
		    label.appendChild(document.createTextNode(line[0]));
		    let pathToDownload = path + line[0];
		    label.onclick = async function() {
			let reply = (await executeInRawRepl("with open('" + pathToDownload + "', 'rb') as f:\n while 1:\n"
							   + "  b=f.read(256)\n  if not b:break\n  print(b)")).trim();
			reply = reply.split("\r\n");
			let totalLength = 0;
			for(let i = 0; i < reply.length; i++){
			    reply[i] = unescapeLine(reply[i]);
			    totalLength += reply[i].length;
			}
			let out = new Uint8Array(totalLength);
			totalLength = 0;
			for(let i = 0; i < reply.length; i++){
			    out.set(reply[i], totalLength);
			    totalLength += reply[i].length;
			}
			saveAs(new Blob([out], {type: "application/octet-stream"}), line[0]);
		    };
		}
	    }
	}
    }
}
(function() {
    window.onload = function() {
      var url = window.location.hash.substring(1);
      if (!url) {
          // pre-populate the url based on the host that served this page.
          url = document.location.host;
      }
      document.getElementById('url').value = 'ws://' + url;
      var size = calculate_size(self);
      term = new Terminal({
        cols: size[0],
        rows: size[1],
        useStyle: true,
        screenKeys: true,
        cursorBlink: false
      });
      term.open(document.getElementById("term"));
	show_https_warning();
	let boxes = document.getElementById("file-boxes");
	boxes.removeChild(boxes.firstElementChild);
	boxes.removeChild(boxes.firstElementChild);
	let fileUpload = document.createElement("input");
	fileUpload.setAttribute("type", "file");
	fileUpload.setAttribute("id", "put-file-select");
	fileUpload.style.display = "none";
	fileUpload.multiple = true;
	boxes.appendChild(fileUpload);
	let rootMip = document.createElement("div");
	boxes.parentNode.insertBefore(rootMip, boxes.nextSibling);
	rootMip.style.display="inline-block";
	rootMip.style.vertical_align="top";
	rootMip.style.width="230px";
	rootMip.setAttribute("class", "file-box");
	new MIP(rootMip);
	let rootFile = document.createElement("div");
	document.getElementById("file-status").appendChild(rootFile);
	new RemoteDirectory(rootFile, "/", "/");
    };
    window.addEventListener('resize', function() {
        var size = calculate_size(self);
        term.resize(size[0], size[1]);
    });
    document.getElementById("pw").onchange = button_click;
    document.getElementById("pw").onfocus = (e) => {
	document.getElementById("pw").onchange = null;
    }
}).call(this);

function show_https_warning() {
    if (window.location.protocol == 'https:') {
        var warningDiv = document.createElement('div');
        warningDiv.style.cssText = 'background:#f99;padding:5px;margin-bottom:10px;line-height:1.5em;text-align:center';
        warningDiv.innerHTML = [
            'The WebREPL client cannot be accessed over HTTPS connections.',
            'Load the WebREPL client from the device instead.'
        ].join('<br>');
        document.body.insertBefore(warningDiv, document.body.childNodes[0]);
        term.resize(term.cols, term.rows - 7);
    }
}

function button_click() {
    if (connected) {
        ws.close();
    } else {
        document.getElementById('url').disabled = true;
	document.getElementById('pw').disabled = true;
        document.getElementById('button').value = "Disconnect";
        connected = true;
        connect(document.getElementById('url').value, document.getElementById('pw').value);
    }
}

function prepare_for_connect() {
    document.getElementById('url').disabled = false;
    document.getElementById('button').value = "Connect";
}

function update_file_status(s) {
    document.getElementById('file-status').innerHTML = s;
}

class StreamFilter {
    constructor(next) {
	this.next = next;
        this.data = [];
	this.openPromise = null;
	this.idx = 0;
    }
    accept(data) {
	this.data.push(data);
	if(this.openPromise != null){
	    this.openPromise(this.read());
	    this.openPromise = null;
	}
    }
    async readU4() {
	return (await this.read()) | (await this.read() << 8) | (await this.read() << 16) | (await this.read() << 24);
    }
    encodeU4(i) {
	return new Uint8Array([i & 0xFF, (i>>8) & 0xFF, (i>>16) & 0xFF, (i>>24) & 0xFF]);
    }
    async readStr() {
	let len = await this.readU4();
	let data = "";
	for(let i = 0; i < len; i++){
	    data += String.fromCharCode(await this.read());
	}
	return data;
    }
    async read() {
	if(this.data.length != 0){
	    let out = this.data[0][this.idx];
	    this.idx++;
	    if(this.idx >= this.data[0].length) {
		this.data.shift();
		this.idx = 0;
	    }
	    return out;
	}
	let parser = this;
	return new Promise((resolve) => parser.openPromise = resolve);
    }
    async process() {
	while(true){
	    this.next([await read()]);
	}
    }
}
class FileEntryFS {
    constructor(root) {
	this.root = root;
    }
    async resolveDirectory(path) {
	if(path == "/"){
	    if(this.root.isDirectory){
		return this.root;
	    }
	    throw new Error("wrong type");
	}
	let self = this;
	if(path.endsWith("/")){
	    path = path.substr(0, path.length - 1);
	}
	return new Promise((res, rej) => {
	    self.root.getDirectory(path.substr(1), {}, res, rej);
	});
    }
    async resolveFile(path) {
	if(path == "/"){
	    if(this.root.isFile){
		return this.root;
	    }
	    throw new Error("wrong type");
	}
	let self = this;
	return new Promise((res, rej) => {
	    self.root.getFile(path.substr(1), {}, res, rej);
	});
    }
    async exists(path){
	try {
	    await this.resolveDirectory(path);
	    return true;
	} catch(e) {
	}
	try {
	    await this.resolveFile(path);
	    return true;
	} catch(e) {
	}
	return false;
    }
    async isDirectory(path) {
	try {
	    await this.resolveDirectory(path);
	    return true;
	} catch(e) {
	    return false;
	}
    }
    async list(path) {
	let dir = await this.resolveDirectory(path);
	let r = dir.createReader();
	let entries = await new Promise((res, rej) => {
	    r.readEntries(res);
	});
	console.log(entries);
	let result = [];
	for(let entry of entries) {
	    if(entry.isFile) {
		result.push({name: entry.name, isdir: false});
	    } else if(entry.isDirectory) {
		result.push({name: entry.name, isdir: true});
	    }

	}
	return result;
    }
    async getBuffer(path) {
	let file = await this.resolveFile(path);
	console.log("getBuffer: " + file);
	let fr = new FileReader();
	let p = new Promise((res, rej) => {
	    fr.onload = res;
	});
	let pFile = await new Promise((res, rej) => file.file(res));
	console.log(pFile);
	fr.readAsArrayBuffer(pFile);
	console.log("waiting for file reader");
	console.log(fr);
	await p;
	console.log(fr.result);
	return new Uint8Array(fr.result);
    }
}
class MountpointFS {
    constructor() {
	this.mountpoints = {};
    }
    getMountpointFn(path, fn) {
	let [m, p] = this.getMountpoint(path);
	return m[fn](p);
    }
    getMountpointOnly(path) {
	let hit = undefined;
	let hitLen = -1;
	for(let mountpoint in this.mountpoints) {
	    if(path.startsWith(mountpoint) && mountpoint.length > hitLen) {
		hitLen = mountpoint.length;
		hit = mountpoint;
	    }
	}	
	return [this.mountpoints[hit], hit];
    }
    getMountpoint(path) {
	let [m, p0] = this.getMountpointOnly(path);
	return [m, path.substr(p0.length)];
    }
    exists(path) {
	return this.getMountpointFn(path, "exists");
    }
    isDirectory(path) {
	return this.getMountpointFn(path, "isDirectory");
    }
    async list(path) {
	let child = this.getMountpointFn(path, "list");
	for(let mountpoint in this.mountpoints) {
	    if(mountpoint.startsWith(path) && mountpoint.substr(path.length).indexOf("/") === -1) {
		let remainder = mountpoint.substr(path.length);
		child.push({name: remainder, isdir: await this.mountpoints[mountpoint].isDirectory("/")});
	    }
	}
	return child;
    }
    getBuffer(path) {
	return this.getMountpointFn(path, "getBuffer");
    }
    write(path, buffer) {
	let [m, p] = this.getMountpoint(path);
	return m.write(p, buffer);
    }
    unlink(path){
	return this.getMountpointFn(path, "unlink");
    }
    rename(path, pathNew){
	let [m, p0] = this.getMountpointOnly(path);
	m.rename(path.substr(p0.length), pathNew.substr(p0.length));
    }
    mkdir(path){
	return this.getMountpointFn(path, "mkdir");
    }
}
class LocalstorageFS {
    exists(path) {
	return localStorage[path] !== undefined;
    }
    isDirectory(path) {
	return localStorage[path].startsWith("dir,");
    }
    list(pathToList) {
	let result = [];
	for(let path of Object.keys(localStorage)) {
	    if(path.startsWith(pathToList)){
		let remainder = path.substr(pathToList.length);
		if(remainder.indexOf("/") == -1) {
		    result.push({name: remainder, isdir: localStorage[path].startsWith("dir,")});
		}
	    }
	}
	return result;
    }
    async getBuffer(path) {
	return new Uint8Array(await (await fetch(localStorage[path])).arrayBuffer())
    }
    async write(path, buffer) {
	let b64 = await readAsDataURL(new Blob([buffer]));
	localStorage[path] = b64;
    }
    unlink(path) {
 	delete localStorage[path];
    }
    rename(path, pathNew) {
	localStorage[pathNew] = localStorage[path];
	delete localStorage[path];
    }
    mkdir(path) {
	localStorage[path] = "dir,";
    }
}
let theFs = new MountpointFS();
theFs.mountpoints[""] = new LocalstorageFS();

class RemoteFSFilter extends StreamFilter {
    constructor(next) {
	super(next);
	this.fds = {};
	this.fs = theFs;
	this.process();
    }
    async readPath () {
	let path = await this.readStr();
	path = path.replace("//", "/");
	return path;
    }
    async handleCommand(){
	let code = await this.read();
	if(code == 1){
	    let path = await this.readPath();
	    console.log("stat(" + path + ")");
	    if(await this.fs.exists(path)) {
		if(!await this.fs.isDirectory(path)) {
		    ws.send("\x00");
		    ws.send(new Uint8Array([0,0x80,0,0]));
		    ws.send("\x0e\x00\x00\x00");
		    ws.send("\x00\x00\x00\x00");
		    ws.send("\x00\x00\x00\x00");
		    ws.send("\x00\x00\x00\x00");
		} else {
		    ws.send("\x00");
		    ws.send("\x00\x40\x00\x00")
		    ws.send("\x00\x00\x00\x00");
		    ws.send("\x00\x00\x00\x00");
		    ws.send("\x00\x00\x00\x00");
		    ws.send("\x00\x00\x00\x00");
		}
	    } else {
		ws.send(new Uint8Array([0xfe]));
	    }
	    
	    /*self.wr_s8(0)
	      # Note: st_ino would need to be 64-bit if added here
	      self.wr_u32(stat.st_mode)
	      self.wr_u32(stat.st_size)
	      self.wr_u32(int(stat.st_atime))
	      self.wr_u32(int(stat.st_mtime))
	      self.wr_u32(int(stat.st_ctime))*/
	} else if(code == 2) {
	    let pathToList = await this.readPath();
	    console.log("ilistdir(" + pathToList + ")");
	    pathToList += "/";
	    pathToList = pathToList.replace("//", "/");
	    ws.send("\x00");
	    this.remainingFiles = await this.fs.list(pathToList);
	    console.log(this.remainingFiles);
	    return false;
	} else if(code == 3) {
	    let file = 0o100000;
	    let dir = 0o040000;
	    if(this.remainingFiles.length == 0) {
		ws.send("\x00\x00\x00\x00");
	    } else {
		let path = this.remainingFiles.pop();
		ws.send(this.encodeU4(path.name.length));
		ws.send(path.name);
		if(path.isdir) {
		    ws.send("\x00\x40\x00\x00");
		} else {
		    ws.send("\x00\x80\x00\x00");
		}
	    }
	} else if(code == 4) {
	    let path = await this.readPath();
	    let mode = await this.readStr();
	    console.log("Open: " + path + ";" + mode + " = 5");
	    if(mode == "wb" || mode == "w") {
		ws.send("\x05");
		this.fds[5] = {write: true, path: path,  pos: 0, buffer: new Uint8Array(4096 * 16)};		
	    } else {
		if(await this.fs.exists(path) && !await this.fs.isDirectory(path)) {
		    ws.send("\x05");
		    this.fds[5] = {pos: 0, buffer: await this.fs.getBuffer(path)};
		} else {
		    ws.send(new Uint8Array([0xfe]));		
		}
	    }
	    console.log(this.fds[5]);
	} else if(code == 5) {
	    let fd = await this.read();
	    if(this.fds[fd].write) {
		let fdo = this.fds[fd];
		let buffer = new Uint8Array(fdo.buffer.buffer, 0, fdo.pos);
		await this.fs.write(fdo.path, buffer);
	    }
	    delete this.fds[fd];
	    console.log("Close: " + fd);
	} else if(code == 6) {
	    let fd = await this.read();
	    let len = await this.readU4();
	    let fdo = this.fds[fd];
	    let toRead = Math.min(len, fdo.buffer.length - fdo.pos);
	    if(len == -1){
		toRead = fdo.buffer.length - fdo.pos;
	    }
	    ws.send(this.encodeU4(toRead));
	    ws.send(fdo.buffer.slice(fdo.pos, fdo.pos + toRead));
	    fdo.pos += toRead;
	    console.log("read(" + fd + ", " + len + ") = " + toRead);
	} else if(code == 7) {
	    let fd = await this.read();
	    let len = await this.readU4();
	    let buf = new Uint8Array(len);
	    for(let i = 0; i < buf.length; i++){
		buf[i] = await this.read();
	    }
	    console.log("write(" + fd + ", " + len + ")");
	    let fdo = this.fds[fd];
	    fdo.buffer.set(buf, fdo.pos);
	    fdo.pos += len;
	    ws.send(this.encodeU4(len));
	// } else if(code == 8) {
	} else if(code == 9) {
	    let path = await this.readPath();
	    console.log("unlink(" + path + ")");
	    if(await this.fs.exists(path) && !await this.fs.isDirectory(path)) {
		await this.fs.unlink(path);
		ws.send("\x00\x00\x00\x00");
	    } else {
		ws.send(new Uint8Array([0xfe, 0xff, 0xff, 0xff]));
	    }	    
	} else if(code == 10) {
	    let path = await this.readPath();
	    let pathNew = await this.readPath();
	    console.log("rename(" + path + ", " + pathNew + ")");
	    if(await this.fs.exists(path)) {
		await this.fs.rename(path, pathNew);
		ws.send("\x00\x00\x00\x00");
	    } else {
		ws.send(new Uint8Array([0xfe, 0xff, 0xff, 0xff]));
	    }	    
	} else if(code == 11) {
	    let path = await this.readPath();
	    console.log("mkdir(" + path + ")");
	    if(await this.fs.exists(path)) {
		ws.send(new Uint8Array([0xef, 0xff, 0xff, 0xff]));
	    } else {
		await this.fs.mkdir(path);
		ws.send("\x00\x00\x00\x00");
	    }	    
	} else if(code == 12) {
	    let path = await this.readPath();
	    console.log("rmdir(" + path + ")");
	    if(path in localStorage && localStorage[path].startsWith("dir")) {
		let found = false;
		for(let path1 of Object.keys(localStorage)){
		    if(path1 != path && path1.startsWith(path+"/")) {
			found = true;
		    }
		}
		if(found) {
		    ws.send(new Uint8Array([0xd9, 0xff, 0xff, 0xff]));
		} else {
		    delete localStorage[path];
		    ws.send("\x00\x00\x00\x00");
		}
	    } else {
		ws.send(new Uint8Array([0xfe, 0xff, 0xff, 0xff]));
	    }	    
	} else {
	    console.log("Unknown opcode: " + code);
	}
    }
    async process() {
	while(true) {
	    let b = await this.read();
	    if(b == 0x18) {
		ws.send("\x18");
		await this.handleCommand();
		continue;
	    }
	    this.next([b]);
	}
    }
}

class WebreplSession {
    constructor(){
	this.filter = [new RemoteFSFilter(b => term.write(String.fromCharCode(b)))];
    }
    connect(url, pw) {
	let ws = new WebSocket(url);
	let commandParser = this;
	this.ws = ws;
	ws.binaryType = 'arraybuffer';
	ws.onopen = function() {
            term.removeAllListeners('data');
            term.on('data', function(data) {
		// Pasted data from clipboard will likely contain
		// LF as EOL chars.
		data = data.replace(/\n/g, "\r");
		ws.send(data);
            });

            term.on('title', function(title) {
		document.title = title;
            });

            term.focus();
            term.element.focus();
            term.write('\x1b[31mWelcome to MicroPython!\x1b[m\r\n');
	    ws.send(pw+"\n");

            ws.onmessage = function(event) {
		if (event.data instanceof ArrayBuffer) {
                    var data = new Uint8Array(event.data);
		    //term.write(new TextDecoder("utf-8").decode(data));
		    commandParser.append(data);
		} else {
		    commandParser.append(event.data);
		}
            };
	};

	ws.onclose = function() {
            connected = false;
            if (term) {
		term.write('\x1b[31mDisconnected\x1b[m\r\n');
            }
            term.off('data');
            prepare_for_connect();
	}
    }
    pushFilt(filt) {
	let current = this.filter[this.filter.length-1];
	filt.next = current.next;
	current.next = (b) => filt.accept(b);
	this.filter.push(filt);
    }
    popFilt(filt) {
	let removing = this.filter.pop();
	this.filter[this.filter.length-1].next = removing.next;
	if(removing != filt){
	    throw Error("Push/Pop did not match");
	}
    }
    send(data) {
	this.ws.send(data);
    }
    close() {
	this.ws.close();
    }
    append(data) {
	this.filter[0].accept(data);
    }
}


function connect(url, pw) {
    var hostport = url.substring(5);
    if (hostport === document.location.host) {
        hostport = '';
    }

    window.location.hash = hostport;
    ws = new WebreplSession();
    ws.connect(url, pw);
}

function decode_resp(data) {
    if (data[0] == 'W'.charCodeAt(0) && data[1] == 'B'.charCodeAt(0)) {
        var code = data[2] | (data[3] << 8);
        return code;
    } else {
        return -1;
    }
}

function get_file() {
    var src_fname = document.getElementById('get_filename').value;

    // WEBREPL_FILE = "<2sBBQLH64s"
    var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 2; // get
    rec[3] = 0;
    rec[4] = 0; rec[5] = 0; rec[6] = 0; rec[7] = 0; rec[8] = 0; rec[9] = 0; rec[10] = 0; rec[11] = 0;
    rec[12] = 0; rec[13] = 0; rec[14] = 0; rec[15] = 0;
    rec[16] = src_fname.length & 0xff; rec[17] = (src_fname.length >> 8) & 0xff;
    for (var i = 0; i < 64; ++i) {
        if (i < src_fname.length) {
            rec[18 + i] = src_fname.charCodeAt(i);
        } else {
            rec[18 + i] = 0;
        }
    }

    // initiate get
    binary_state = 21;
    get_file_name = src_fname;
    get_file_data = new Uint8Array(0);
    update_file_status('Getting ' + get_file_name + '...');
    ws.send(rec);
}

function get_ver() {
    // WEBREPL_REQ_S = "<2sBBQLH64s"
    var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 3; // GET_VER
    // rest of "rec" is zero

    // initiate GET_VER
    binary_state = 31;
    ws.send(rec);
}

function handle_put_file_select(evt) {
    // The event holds a FileList object which is a list of File objects,
    // but we only support single file selection at the moment.
    var files = evt.target.files;

    // Get the file info and load its data.
    var f = files[0];
    put_file_name = f.name;
    var reader = new FileReader();
    reader.onload = function(e) {
        let put_file_data = new Uint8Array(e.target.result);
        document.getElementById('put-file-list').innerHTML = '' + escape(put_file_name) + ' - ' + put_file_data.length + ' bytes';
        document.getElementById('put-file-button').disabled = false;
    };
    reader.readAsArrayBuffer(f);
}

document.getElementById('put-file-select').addEventListener('click', function(){
    this.value = null;
}, false);

document.getElementById('put-file-select').addEventListener('change', handle_put_file_select, false);
document.getElementById('put-file-button').disabled = true;



let fs_hook_cmds = {
    "CMD_STAT": 1,
    "CMD_ILISTDIR_START": 2,
    "CMD_ILISTDIR_NEXT": 3,
    "CMD_OPEN": 4,
    "CMD_CLOSE": 5,
    "CMD_READ": 6,
    "CMD_WRITE": 7,
    "CMD_SEEK": 8,
    "CMD_REMOVE": 9,
    "CMD_RENAME": 10,
    "CMD_MKDIR": 11,
    "CMD_RMDIR": 12,
}

let fs_hook_code = `
import os, io, struct, micropython

SEEK_SET = 0

class RemoteCommand:
    def __init__(self):
        import select, sys
        self.buf4 = bytearray(4)
        self.fout = sys.stdout.buffer
        self.fin = sys.stdin.buffer
        self.poller = select.poll()
        self.poller.register(self.fin, select.POLLIN)

    def poll_in(self):
        for _ in self.poller.ipoll(1000):
            return
        self.end()
        raise Exception('timeout waiting for remote')

    def rd(self, n):
        buf = bytearray(n)
        self.rd_into(buf, n)
        return buf

    def rd_into(self, buf, n):
        # implement reading with a timeout in case other side disappears
        if n == 0:
            return
        self.poll_in()
        r = self.fin.readinto(buf, n)
        if r < n:
            mv = memoryview(buf)
            while r < n:
                self.poll_in()
                r += self.fin.readinto(mv[r:], n - r)

    def begin(self, type):
        micropython.kbd_intr(-1)
        buf4 = self.buf4
        buf4[0] = 0x18
        buf4[1] = type
        self.fout.write(buf4, 2)
        # Wait for sync byte 0x18, but don't get stuck forever
        for i in range(30):
            self.poller.poll(1000)
            self.fin.readinto(buf4, 1)
            if buf4[0] == 0x18:
                break

    def end(self):
        micropython.kbd_intr(3)

    def rd_s8(self):
        self.rd_into(self.buf4, 1)
        n = self.buf4[0]
        if n & 0x80:
            n -= 0x100
        return n

    def rd_s32(self):
        buf4 = self.buf4
        self.rd_into(buf4, 4)
        n = buf4[0] | buf4[1] << 8 | buf4[2] << 16 | buf4[3] << 24
        if buf4[3] & 0x80:
            n -= 0x100000000
        return n

    def rd_u32(self):
        buf4 = self.buf4
        self.rd_into(buf4, 4)
        return buf4[0] | buf4[1] << 8 | buf4[2] << 16 | buf4[3] << 24

    def rd_bytes(self, buf):
        # TODO if n is large (eg >256) then we may miss bytes on stdin
        n = self.rd_s32()
        if buf is None:
            ret = buf = bytearray(n)
        else:
            ret = n
        self.rd_into(buf, n)
        return ret

    def rd_str(self):
        n = self.rd_s32()
        if n == 0:
            return ''
        else:
            return str(self.rd(n), 'utf8')

    def wr_s8(self, i):
        self.buf4[0] = i
        self.fout.write(self.buf4, 1)

    def wr_s32(self, i):
        struct.pack_into('<i', self.buf4, 0, i)
        self.fout.write(self.buf4)

    def wr_bytes(self, b):
        self.wr_s32(len(b))
        self.fout.write(b)

    # str and bytes act the same in MicroPython
    wr_str = wr_bytes


class RemoteFile(io.IOBase):
    def __init__(self, cmd, fd, is_text):
        self.cmd = cmd
        self.fd = fd
        self.is_text = is_text

    def __enter__(self):
        return self

    def __exit__(self, a, b, c):
        self.close()

    def __iter__(self):
        return self

    def __next__(self):
        l = self.readline()
        if not l:
            raise StopIteration
        return l

    def ioctl(self, request, arg):
        if request == 1:  # FLUSH
            self.flush()
        elif request == 2:  # SEEK
            # This assumes a 32-bit bare-metal machine.
            import machine
            machine.mem32[arg] = self.seek(machine.mem32[arg], machine.mem32[arg + 4])
        elif request == 4:  # CLOSE
            self.close()
        elif request == 11:  # BUFFER_SIZE
            # This is used as the vfs_reader buffer. n + 4 should be less than 255 to
            # fit in stdin ringbuffer on supported ports. n + 7 should be multiple of 16
            # to efficiently use gc blocks in mp_reader_vfs_t.
            return 249
        else:
            return -1
        return 0

    def flush(self):
        pass

    def close(self):
        if self.fd is None:
            return
        c = self.cmd
        c.begin(CMD_CLOSE)
        c.wr_s8(self.fd)
        c.end()
        self.fd = None

    def read(self, n=-1):
        c = self.cmd
        c.begin(CMD_READ)
        c.wr_s8(self.fd)
        c.wr_s32(n)
        data = c.rd_bytes(None)
        c.end()
        if self.is_text:
            data = str(data, 'utf8')
        else:
            data = bytes(data)
        return data

    def readinto(self, buf):
        c = self.cmd
        c.begin(CMD_READ)
        c.wr_s8(self.fd)
        c.wr_s32(len(buf))
        n = c.rd_bytes(buf)
        c.end()
        return n

    def readline(self):
        l = ''
        while 1:
            c = self.read(1)
            l += c
            if c == '\\n' or c == '':
                return l

    def readlines(self):
        ls = []
        while 1:
            l = self.readline()
            if not l:
                return ls
            ls.append(l)

    def write(self, buf):
        c = self.cmd
        c.begin(CMD_WRITE)
        c.wr_s8(self.fd)
        c.wr_bytes(buf)
        n = c.rd_s32()
        c.end()
        return n

    def seek(self, n, whence=SEEK_SET):
        c = self.cmd
        c.begin(CMD_SEEK)
        c.wr_s8(self.fd)
        c.wr_s32(n)
        c.wr_s8(whence)
        n = c.rd_s32()
        c.end()
        if n < 0:
            raise OSError(n)
        return n


class RemoteFS:
    def __init__(self, cmd):
        self.cmd = cmd

    def mount(self, readonly, mkfs):
        pass

    def umount(self):
        pass

    def chdir(self, path):
        if not path.startswith("/"):
            path = self.path + path
        if not path.endswith("/"):
            path += "/"
        if path != "/":
            self.stat(path)
        self.path = path

    def getcwd(self):
        return self.path

    def remove(self, path):
        c = self.cmd
        c.begin(CMD_REMOVE)
        c.wr_str(self.path + path)
        res = c.rd_s32()
        c.end()
        if res < 0:
            raise OSError(-res)

    def rename(self, old, new):
        c = self.cmd
        c.begin(CMD_RENAME)
        c.wr_str(self.path + old)
        c.wr_str(self.path + new)
        res = c.rd_s32()
        c.end()
        if res < 0:
            raise OSError(-res)

    def mkdir(self, path):
        c = self.cmd
        c.begin(CMD_MKDIR)
        c.wr_str(self.path + path)
        res = c.rd_s32()
        c.end()
        if res < 0:
            raise OSError(-res)

    def rmdir(self, path):
        c = self.cmd
        c.begin(CMD_RMDIR)
        c.wr_str(self.path + path)
        res = c.rd_s32()
        c.end()
        if res < 0:
            raise OSError(-res)

    def stat(self, path):
        c = self.cmd
        c.begin(CMD_STAT)
        c.wr_str(self.path + path)
        res = c.rd_s8()
        if res < 0:
            c.end()
            raise OSError(-res)
        mode = c.rd_u32()
        size = c.rd_u32()
        atime = c.rd_u32()
        mtime = c.rd_u32()
        ctime = c.rd_u32()
        c.end()
        return mode, 0, 0, 0, 0, 0, size, atime, mtime, ctime

    def ilistdir(self, path):
        c = self.cmd
        c.begin(CMD_ILISTDIR_START)
        c.wr_str(self.path + path)
        res = c.rd_s8()
        c.end()
        if res < 0:
            raise OSError(-res)
        def next():
            while True:
                c.begin(CMD_ILISTDIR_NEXT)
                name = c.rd_str()
                if name:
                    type = c.rd_u32()
                    c.end()
                    yield (name, type, 0)
                else:
                    c.end()
                    break
        return next()

    def open(self, path, mode):
        c = self.cmd
        c.begin(CMD_OPEN)
        c.wr_str(self.path + path)
        c.wr_str(mode)
        fd = c.rd_s8()
        c.end()
        if fd < 0:
            raise OSError(-fd)
        return RemoteFile(c, fd, mode.find('b') == -1)


def __mount():
    os.mount(RemoteFS(RemoteCommand()), '/remote')
    os.chdir('/remote')
`
for(const [key, value] of Object.entries(fs_hook_cmds)) {
    fs_hook_code = fs_hook_code.replaceAll(key, value);
}
fs_hook_code = fs_hook_code.replaceAll(" *#.*$", "")
fs_hook_code = fs_hook_code.replaceAll("\n\n+", "\n")
fs_hook_code = fs_hook_code.replaceAll("    ", " ")
fs_hook_code = fs_hook_code.replaceAll("rd_", "r")
fs_hook_code = fs_hook_code.replaceAll("wr_", "w")
fs_hook_code = fs_hook_code.replaceAll("buf4", "b4")

async function sleep(len) {
    return new Promise(resolve => {
	setTimeout(resolve, len);
    });
}

class RawREPLFilter extends StreamFilter {
    constructor(next) {
	super(next);
    }
    async filtUntil(search) {
	let i = 0;
	while(true){
	    if(i >= search.length){
		return;
	    }
	    let c = await this.read();
	    if(c == search.charCodeAt(i)) {
		i++;
	    } else {
		// TODO, foward?
		i = 0;
	    }
	}
    }
    async skipUntil(search) {
	let i = 0;
	while(true){
	    if(i >= search.length){
		return;
	    }
	    let c = await this.read();
	    if(c == search.charCodeAt(i)) {
		i++;
	    } else {
		i = 0;
	    }
	}
    }
    async readUntil(target){
	let output = [];
	while(true) {
	    let chr = await this.read();
	    if(chr == target){
		break;
	    }
	    output.push(chr);
	}
	return output;
    }
    async expectNext(search) {
	let i = 0;
	while(true){
	    if(i >= search.length){
		return;
	    }
	    let c = await this.read();
	    if(c == search.charCodeAt(i)) {
		i++;
	    } else {
		throw Error();
	    }
	}
    }
    accept(ch) {
	super.accept(ch);
    }
}
async function hookme(){
    let code = fs_hook_code.replaceAll("\n","\r");
    return executeInRawRepl(code);
}
async function executeInRawRepl(code) {
    return executeStatementsInRawRepl(async (execute) => {
	return execute(code);
    });
}

async function executeStatementsInRawRepl(statement){
    let filt = new RawREPLFilter();
    ws.pushFilt(filt);
    let rawReplReply = "\r\nraw REPL; CTRL-B to exit\r\n>";
    ws.send("\x01");
    let result = null;
    try {
	await filt.filtUntil(rawReplReply);
	result = await statement(async(code) => {
	    ws.send("\x05A\x01");
	    let bytes = [await filt.read(), await filt.read()];
	    if(bytes[0] != 0x52 || bytes[1] != 1) {
		throw Error("Raw paste mode not supported");
		return;
		ws.send("\x05");
		for(let i = 0; i < code.length; i += 128){
		    ws.send(code.substr(i, 128));
		    await sleep(100);
		}
		ws.send("\x04");
		return;
	    }
	    let flowControl = await filt.read() | (await filt.read() << 8);
	    for(let i = 0; i < code.length; i += flowControl) {
		ws.send(code.substr(i,flowControl));
		let reply = await filt.read();
		if(reply == 1) {
		    continue;
		} else if(reply == 4) {
		    throw Error("Device requested abort");
		} else {
		    throw Error("Unknown error in raw paste mode: " + reply);
		}
	    }
	    ws.send("\x04");
	    await filt.skipUntil("\x04");
	    let output = await filt.readUntil(4);
	    let except = await filt.readUntil(4);
	    if(await filt.read() != 0x3e){
		throw Error("Raw repl did not came back as expected");
	    }
	    let dec = new TextDecoder("utf-8");
	    let err = dec.decode(new Uint8Array(except));
	    if(err != "") {
		throw Error(err);
	    }
	    return dec.decode(new Uint8Array(output));
	});
    } finally {
	ws.popFilt(filt);
	ws.send("\x02");
    }
    return result;
}


async function ls(path){
    let reply = await executeInRawRepl("import os, json\nprint(json.dumps([f for f in os.ilistdir('" + path + "')]))");
    return JSON.parse(reply)
}
