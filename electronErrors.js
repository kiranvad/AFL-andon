function isExpectedWebviewNavigationAbort(error) {
  return error?.code === 'ERR_ABORTED' &&
    Number(error?.errno) === -3 &&
    /^https?:\/\//.test(String(error?.url || ''));
}

module.exports = { isExpectedWebviewNavigationAbort };
