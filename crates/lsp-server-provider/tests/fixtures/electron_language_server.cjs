let bytes = Buffer.alloc(0);
process.stdin.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk]);
    for (;;) {
        const header = bytes.indexOf('\r\n\r\n');
        if (header < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(bytes.subarray(0, header).toString())[1]);
        if (bytes.length < header + 4 + length) return;
        const request = JSON.parse(bytes.subarray(header + 4, header + 4 + length));
        bytes = bytes.subarray(header + 4 + length);
        if (request.method === 'exit') process.exit(0);
        if (request.id === undefined) continue;
        let result = null;
        if (request.method === 'initialize') result = { capabilities: { hoverProvider: true } };
        if (request.method === 'textDocument/hover') result = { contents: { kind: 'plaintext', value: `Electron ${process.versions.electron}; Node ${process.versions.node}` } };
        const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        process.stdout.write(`Content-Length: ${response.length}\r\n\r\n`);
        process.stdout.write(response);
    }
});
