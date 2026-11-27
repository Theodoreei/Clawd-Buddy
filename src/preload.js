const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buddy", {
  init: () => ipcRenderer.invoke("init"),
  send: (text) => ipcRenderer.send("send", text),
  stop: () => ipcRenderer.send("stop"),
  newChat: () => ipcRenderer.send("new-chat"),
  answerApproval: (id, decision) => ipcRenderer.send("approval", { id, decision }),
  setApiKey: (key) => ipcRenderer.invoke("set-api-key", key),
  setIgnoreMouse: (ignore) => ipcRenderer.send("set-ignore", ignore),
  focus: () => ipcRenderer.send("focus"),
  contextMenu: () => ipcRenderer.send("context-menu"),
  resize: (dir) => ipcRenderer.send("resize", dir),
  dragStart: (x, y) => ipcRenderer.send("drag-start", { x, y }),
  dragMove: (x, y) => ipcRenderer.send("drag-move", { x, y }),
  dragEnd: () => ipcRenderer.send("drag-end"),
  on: (fn) => ipcRenderer.on("buddy", (_e, msg) => fn(msg)),
});
