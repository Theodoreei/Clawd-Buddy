const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("companion", {
  state: () => ipcRenderer.invoke("c:state"),
  set: (key, value) => ipcRenderer.invoke("c:set", { key, value }),
  saveApiKey: (key) => ipcRenderer.invoke("c:apiKey:save", key),
  testApiKey: () => ipcRenderer.invoke("c:apiKey:test"),
  removeApiKey: () => ipcRenderer.invoke("c:apiKey:remove"),
  connectSlack: (token) => ipcRenderer.invoke("c:slack:connect", token),
  disconnectSlack: () => ipcRenderer.invoke("c:slack:disconnect"),
  saveMcp: (list) => ipcRenderer.invoke("c:mcp:save", list),
  setClaudeCode: (patch) => ipcRenderer.invoke("c:cc:set", patch),
  pickFolder: () => ipcRenderer.invoke("c:cc:pickFolder"),
  detectClaudeCode: () => ipcRenderer.invoke("c:cc:detect"),
  open: (url) => ipcRenderer.send("c:open", url),
  on: (fn) => ipcRenderer.on("companion", (_e, msg) => fn(msg)),
});
