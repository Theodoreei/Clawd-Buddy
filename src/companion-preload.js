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
  connectGithub: (token) => ipcRenderer.invoke("c:github:connect", token),
  githubUseCli: () => ipcRenderer.invoke("c:github:useCli"),
  connectLinear: (key) => ipcRenderer.invoke("c:linear:connect", key),
  disconnectApp: (name) => ipcRenderer.invoke("c:app:disconnect", name),
  setAppReadOnly: (name, value) => ipcRenderer.invoke("c:app:readOnly", { name, value }),
  setClaudeCode: (patch) => ipcRenderer.invoke("c:cc:set", patch),
  pickFolder: () => ipcRenderer.invoke("c:cc:pickFolder"),
  detectClaudeCode: () => ipcRenderer.invoke("c:cc:detect"),
  connectChat: (sessionId) => ipcRenderer.invoke("c:chat:connect", sessionId),
  freshChat: () => ipcRenderer.invoke("c:chat:fresh"),
  open: (url) => ipcRenderer.send("c:open", url),
  on: (fn) => ipcRenderer.on("companion", (_e, msg) => fn(msg)),
});
