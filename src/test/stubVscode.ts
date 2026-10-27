// Import this first in tests of modules that import `vscode`: it makes `require('vscode')` load fakeVscode.
import Module = require('module');
import * as path from 'path';

const fake = path.join(__dirname, 'fakeVscode.js');
const resolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'vscode' ? fake : resolve.call(this, request, ...rest);
};
