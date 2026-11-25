// Stands in for a dev server: prints its process id and a local URL the way Vite does
// (with color codes around the port), then keeps running until it is stopped.
console.log(`pid=${process.pid}`);
console.log('  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5199\x1b[22m/\x1b[39m');
setInterval(() => {}, 1000);
