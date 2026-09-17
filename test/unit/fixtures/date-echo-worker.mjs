// Fixture for `actual-protocol.test.ts`: echoes back whether the `date` field
// of a received IPC message survived as a real `Date`, and its ISO string if
// so. Kept minimal and dependency-free on purpose — the thing under test is
// Node's own `child_process.fork` serialization mode, not any of Balancr's
// code, so nothing here should be able to mask or fix a wrong result.
process.on('message', (message) => {
  const isDate = message.date instanceof Date
  process.send({ isDate, iso: isDate ? message.date.toISOString() : null })
})
