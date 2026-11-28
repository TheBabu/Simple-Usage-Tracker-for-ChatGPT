import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function createWorker(globals = {}) {
  const storage = {};
  let onMessage;

  function load(filename) {
    const source = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8');
    vm.runInContext(source, ctx, { filename });
  }

  const ctx = vm.createContext({
    AbortSignal, atob, ...globals,
    importScripts: (...filenames) => filenames.forEach(load),
    chrome: {
      storage: { local: {
        async get(keys) {
          const values = {};
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            if (Object.hasOwn(storage, key)) values[key] = storage[key];
          }
          return structuredClone(values);
        },
        async set(updates) { Object.assign(storage, structuredClone(updates)); },
      } },
      runtime: {
        onMessage: { addListener: (fn) => { onMessage = fn; } },
        onInstalled: { addListener() {} },
      },
      tabs: { query: async () => [] },
      windows: { onCreated: { addListener() {} } },
    },
  });
  load('background.js');
  const sendMessage = (message) => new Promise((resolve) => onMessage(message, {}, resolve));
  return { ctx, storage, sendMessage };
}
