// Node marks its built-in SQLite as experimental and warns on first use. The
// API we use is stable enough, so drop that one warning and print the rest.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) return;
  console.warn(`${warning.name}: ${warning.message}`);
});
