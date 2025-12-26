/*

Konstruktion:
  const api = new MultiplayerApi('ws://localhost:8080');

Metoder:
  api.host();                   											// Skapar ny session via servern.
  api.join('ABC123');           											// Ansluter till befintlig session med given sessionskod.
  api.game(dataObj);     													// Skickar godtycklig speldata till alla klienter i sessionen.
  const unsubscribe = api.listen((event, messageId, clientId, data) => {
																			// Reagera på inkommande speldata och sessionshändelser.
  });
  unsubscribe();                 											// Slutar lyssna på inkommande speldata.
*/

export class MultiplayerApi {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.socket = null;
    this.sessionId = null;
    this.listeners = new Set();
    this.queue = [];

    this.onHost = null;
    this.onJoin = null;

    this._connect();
  }

  _connect() {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.socket = new WebSocket(this.serverUrl);

    this.socket.addEventListener("open", () => {
      const pending = this.queue.slice();
      this.queue.length = 0;
      for (let i = 0; i < pending.length; i += 1) {
        this.socket.send(pending[i]);
      }
    });

    this.socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (!payload || typeof payload !== "object") {
        return;
      }

      if (!payload.cmd || typeof payload.cmd !== "string") {
        return;
      }

      console.log("Received payload:", payload);

      const cmd = payload.cmd;
      const messageId =
        typeof payload.messageId === "number" ? payload.messageId : null;
      const clientId =
        typeof payload.clientId === "string" ? payload.clientId : null;
      const data =
        payload.data && typeof payload.data === "object" ? payload.data : {};

      if (cmd === "host") {
        const session =
          typeof payload.session === "string" ? payload.session : null;
        this.sessionId = session;

        if (this.onHost) this.onHost(session, clientId, data);
      } else if (cmd === "join") {
        const session =
          typeof payload.session === "string" ? payload.session : null;
        this.sessionId = session;

        if (this.onJoin) this.onJoin(session, clientId, data);
      } else if (cmd === "joined" || cmd === "leaved" || cmd === "game") {
        console.log(`Received ${cmd} command`);

        this.listeners.forEach((listener) => {
          try {
            listener(cmd, messageId, clientId, data);
          } catch (e) {
            console.error("Error in listener callback:", e);
          }
        });
      }
    });

    this.socket.addEventListener("close", () => {
      this.socket = null;
    });

    this.socket.addEventListener("error", () => {
      // Ingen ytterligare hantering här; spelkoden kan själv reagera på uteblivna meddelanden.
    });
  }

  _enqueueOrSend(serializedMessage) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(serializedMessage);
    } else {
      this.queue.push(serializedMessage);
      this._connect();
    }
  }

  _buildPayload(cmd, data) {
    const payload = {
      session: this.sessionId,
      cmd,
      data: data && typeof data === "object" ? data : {},
    };
    return JSON.stringify(payload);
  }

  host() {
    return new Promise((resolve, reject) => {
      if (this.sessionId) return reject("error_already_hosting_or_joined");

      const serialized = this._buildPayload("host", {});
      this._enqueueOrSend(serialized);

      this.onHost = (session, clientId, data) => {
        this.onHost = null;
        return resolve({ session, clientId, data });
      };
    });
  }

  join(sessionId, data = {}) {
    return new Promise((resolve, reject) => {
      if (this.sessionId) return reject("error_already_hosting_or_joined");

      if (typeof sessionId !== "string")
        return reject("error_invalid_session_id");

      this.onJoin = (session, clientId, data) => {
        this.onJoin = null;
        return resolve({ session, clientId, data });
      };

      this.sessionId = sessionId;
      const serialized = this._buildPayload("join", data);
      this._enqueueOrSend(serialized);
    });
  }

  game(data) {
    const serialized = this._buildPayload("game", data);
    this._enqueueOrSend(serialized);
  }

  listen(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
