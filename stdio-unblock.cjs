try {
  process.stderr._handle.setBlocking(true)
} catch { /* ignore */ }
try {
  process.stdout._handle.setBlocking(true)
} catch { /* ignore */ }
