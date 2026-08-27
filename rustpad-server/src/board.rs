//! Ephemeral presence and pointer relay for collaborative whiteboards.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result};
use futures::prelude::*;
use log::{info, warn};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use warp::ws::{Message, WebSocket};

use crate::crypto;

#[derive(Deserialize)]
struct EpkFrame {
    epk: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct UserInfo {
    name: String,
    hue: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pointer {
    x: f64,
    y: f64,
    tool: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Presence {
    pointer: Option<Pointer>,
    button: String,
    selected_element_ids: HashMap<String, bool>,
}

#[derive(Clone, Debug, Deserialize)]
enum ClientMsg {
    Presence(Presence),
    Scene(serde_json::Value),
}

#[derive(Clone, Debug, Serialize)]
enum ServerMsg {
    Identity(u64),
    Snapshot {
        users: HashMap<u64, UserInfo>,
        presence: HashMap<u64, Presence>,
    },
    User { id: u64, info: Option<UserInfo> },
    Presence { id: u64, data: Presence },
    Scene { id: u64, scene: serde_json::Value },
}

fn encrypted(epk: &str, message: ServerMsg) -> Message {
    let plaintext = serde_json::to_vec(&message).expect("serialize board message");
    match crypto::keys().seal(epk, &plaintext) {
        Some(envelope) => {
            Message::text(serde_json::to_string(&envelope).expect("serialize envelope"))
        }
        None => Message::text("{}"),
    }
}

#[derive(Default)]
struct State {
    users: HashMap<u64, UserInfo>,
    presence: HashMap<u64, Presence>,
}

/// A process-local relay for everyone currently viewing one board.
pub struct BoardHub {
    state: RwLock<State>,
    next_id: AtomicU64,
    updates: broadcast::Sender<ServerMsg>,
}

impl Default for BoardHub {
    fn default() -> Self {
        let (updates, _) = broadcast::channel(128);
        Self {
            state: RwLock::new(State::default()),
            next_id: AtomicU64::new(1),
            updates,
        }
    }
}

impl BoardHub {
    /// Relay one authenticated browser connection until it disconnects.
    pub async fn on_connection(&self, socket: WebSocket, name: String) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        info!("board connection! id = {}", id);
        if let Err(error) = self.handle_connection(id, socket, name).await {
            warn!("board connection terminated early: {}", error);
        }
        self.state.write().users.remove(&id);
        self.state.write().presence.remove(&id);
        self.updates.send(ServerMsg::User { id, info: None }).ok();
        info!("board disconnection, id = {}", id);
    }

    async fn handle_connection(
        &self,
        id: u64,
        mut socket: WebSocket,
        name: String,
    ) -> Result<()> {
        let epk = loop {
            match socket.next().await {
                Some(Ok(message)) if message.is_text() => {
                    match serde_json::from_str::<EpkFrame>(message.to_str().unwrap_or("")) {
                        Ok(frame) => break frame.epk,
                        Err(_) => return Ok(()),
                    }
                }
                Some(Ok(_)) => continue,
                _ => return Ok(()),
            }
        };
        if crypto::keys().seal(&epk, b"ping").is_none() {
            return Ok(());
        }

        let mut updates = self.updates.subscribe();
        socket.send(encrypted(&epk, ServerMsg::Identity(id))).await?;
        let info = UserInfo {
            hue: hue_from_string(&name),
            name,
        };
        self.state.write().users.insert(id, info.clone());
        self.updates
            .send(ServerMsg::User {
                id,
                info: Some(info),
            })
            .ok();
        socket.send(encrypted(&epk, self.snapshot())).await?;

        loop {
            tokio::select! {
                update = updates.recv() => match update {
                    Ok(message) => socket.send(encrypted(&epk, message)).await?,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        socket.send(encrypted(&epk, self.snapshot())).await?
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                incoming = socket.next() => match incoming {
                    Some(Ok(message)) => self.handle_message(id, &epk, message)?,
                    Some(Err(error)) => return Err(error.into()),
                    None => break,
                },
            }
        }
        Ok(())
    }

    fn snapshot(&self) -> ServerMsg {
        let state = self.state.read();
        ServerMsg::Snapshot {
            users: state.users.clone(),
            presence: state.presence.clone(),
        }
    }

    fn handle_message(&self, id: u64, epk: &str, message: Message) -> Result<()> {
        let text = match message.to_str() {
            Ok(text) => text,
            Err(()) => return Ok(()),
        };
        let envelope = serde_json::from_str(text).context("invalid board envelope")?;
        let plaintext = crypto::keys()
            .open(epk, &envelope)
            .context("could not decrypt board message")?;
        let message: ClientMsg =
            serde_json::from_slice(&plaintext).context("invalid board message")?;

        match message {
            ClientMsg::Presence(mut presence) => {
                presence.pointer = presence.pointer.map(|mut pointer| {
                    pointer.x = pointer.x.clamp(-1_000_000.0, 1_000_000.0);
                    pointer.y = pointer.y.clamp(-1_000_000.0, 1_000_000.0);
                    pointer.tool = if pointer.tool == "laser" {
                        "laser".to_string()
                    } else {
                        "pointer".to_string()
                    };
                    pointer
                });
                presence.button = if presence.button == "down" {
                    "down".to_string()
                } else {
                    "up".to_string()
                };
                if presence.selected_element_ids.len() > 10_000 {
                    presence.selected_element_ids.clear();
                }
                self.state.write().presence.insert(id, presence.clone());
                self.updates
                    .send(ServerMsg::Presence { id, data: presence })
                    .ok();
            }
            ClientMsg::Scene(scene) => {
                self.updates.send(ServerMsg::Scene { id, scene }).ok();
            }
        }
        Ok(())
    }
}

fn hue_from_string(value: &str) -> u32 {
    value
        .bytes()
        .fold(0_u32, |hash, byte| hash.wrapping_mul(31).wrapping_add(byte as u32))
        % 360
}
