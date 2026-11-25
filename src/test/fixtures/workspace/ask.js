// Reads one line from stdin and echoes it, to check that typed input reaches the process.
process.stdin.setEncoding('utf8');
process.stdin.once('data', (line) => {
	console.log(`got: ${line.trim()}`);
	process.exit(0);
});
