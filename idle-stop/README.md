# Idle Stop & Player Admin

A Catalyst panel plugin that:

- **stops a game server once its last player leaves** and it stays empty for a grace period;
- shows a **live player list** and lets staff **kick** and **ban** players;
- shows a **ban list** and lets staff **unban**;
- offers a **nuclear reset** — clear all bans and reset the session (it does not kick players) — plus a **clear session** action on its own;
- sends a **welcome message** to players as they join, with one global message for all servers and per-server overrides.

It is a panel plugin (not a game-server mod). It runs inside the panel process and talks to each game server over its normal query/RCON ports.

## How it works

The panel does not send player join/leave events to plugins, so Idle Stop polls each running server:

| Source | Games | Gives |
| --- | --- | --- |
| **A2S query** | Source, CS2, GoldSrc, TF2, … | Player count and player names; no password |
| **Source RCON** | Minecraft Java, Valheim (via ValheimRcon), custom games | `status` / `list` / `players` / `banlist` output; needs the RCON password |
| **Console stream** | Valheim without RCON | Online SteamIDs, built from join/leave console lines |

**Welcome on join** is real-time: the plugin subscribes to the server's live console output through the panel gateway (`ctx.wsGateway.addSseSubscriber`), matches the game's join line, and sends the welcome immediately (Minecraft `tell`, Source/GoldSrc `say`). A poll-based player-list diff runs as a fallback if console output is unavailable or a line was missed, and the two paths are de-duplicated so no one is welcomed twice. Join patterns ship with each preset and can be overridden with `welcomeJoinRegex`.

Built-in presets:

| Preset | Player list | Ban list | Stop | Kick | Ban / Unban |
| --- | --- | --- | --- | --- | --- |
| `minecraft-java` | `list` | `banlist` | `stop` | `kick <name>` | `ban <name>` / `pardon <name>` |
| `source` | `status` (or A2S) | `listid` | `quit` | `kick "#<userid>"` | `banid <min> <steamid> kick` / `removeid <steamid>` |
| `goldsrc` | `status` (or A2S) | `listid` | `quit` | `kick "#<userid>"` | `banid <min> <steamid> kick` / `removeid <steamid>` |
| `valheim` | `players` (ValheimRcon) or console roster | `banlist` | agent | `kick <steamid>` | `ban <steamid>` / `unban <steamid>` |
| `custom` | configure | configure | configure | configure | configure |

`gamePreset: auto` guesses the preset from the server's startup command and environment.

### Valheim

Recommended: install the [ValheimRcon](https://thunderstore.io/c/valheim/p/Tristan/ValheimRcon/) mod, which adds a Source-RCON server to Valheim (the same protocol Minecraft and Conan clients use). Idle Stop then treats Valheim like any other RCON game:

- **Player list**: `players` (names + SteamIDs).
- **Kick / Ban**: `kick <steamid|name>` / `ban <steamid|name>`; **Unban**: `unban <steamid|name>`.
- **Ban list**: `banlist`, plus the plugin's own ban records.
- **Welcome**: `say <message>` (server-wide — Valheim has no per-player message command).

The preset uses `rconPortOffset: 2`, so the RCON port is the game port + 2 (Valheim default `2456` → `2458`) unless you set `rconPort`. The password is auto-detected from `BepInEx/config/org.tristan.rcon.cfg` (the port there is used when set), or you can type it in the server tab. Note: a ValheimRcon password is mandatory — an empty password disables the mod.

**Without the mod** (vanilla Valheim has no query or RCON) the plugin falls back to the console roster: it builds the online list from `Got connection SteamID <id>` (join) and `Closing socket <id>` (leave), configurable with `rosterJoinRegex` / `rosterLeaveRegex`. Rows then show **SteamIDs, not names** — vanilla Valheim does not log names. Because a plugin cannot know who was already online before it started, this fallback roster becomes **authoritative only after the panel observes the server start** (`server:started`); until then **auto-stop is paused** so a populated server is never stopped on incomplete data.

Safety:

- A **query failure never stops a server and never kicks or bans anyone** — only a confirmed empty count for the whole grace period stops a server.
- Every kick/ban/unban command is built from strict allowlisted shapes; player names, reasons and IDs are sanitized so they cannot chain extra console commands.
- A server must be seen running for `minServerUptimeSeconds` before it can be stopped.
- The nuclear reset requires an explicit `{ "confirm": "NUKE" }` and a second confirmation in the UI.
- Only servers you opt in are touched (or all of them if `autoManage` is on).

## Requirements

- The panel must reach the server's A2S/RCON ports. If a server's `primaryIp` is `0.0.0.0` (panel and node on different machines), set `queryHost` / `rconHost` to the node's public IP.
- Minecraft: `enable-rcon=true` in `server.properties` (the plugin can auto-detect `rcon.password` through the file tunnel). Source/GoldSrc need nothing for A2S; RCON is needed for bans and for the richer `status` list.

## Install

Pack the `idle-stop/` directory into a `.catpkg.zip` and install from **Admin → Plugins → Marketplace**, then enable it in **Admin → Plugins**. See the repository `index.json` for the marketplace entry.

## User interface

- **Admin → Idle Stop** — every server with status, managed state, last count, empty-since, last error; **Enable/Disable**, **Test**, **Run check now**, and **Broadcast welcome** to all running servers.
- **Server → Idle Stop** — current state, **Players** (with Kick/Ban per player), **Bans** (local records with Unban, plus the server's live ban list), **Settings**, and a **Danger zone** nuclear reset.

Both tabs are hook-free on purpose: a marketplace install loads `frontend/frontend.mjs`, whose own React copy makes hooks throw. The bundle is built from `frontend/index.ts`:

```bash
npm install react@19.3.0 esbuild     # at the repository root
node build-ui.mjs                    # writes idle-stop/frontend/frontend.mjs
```

React is pinned to 19 to match the panel (`react: ~19.3.0`). The bundle inlines React and has no bare imports.

## Configure

Global defaults live in **Admin → Plugins → Idle Stop**. Everything can be overridden per server through the API.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for background checks. |
| `autoManage` | `false` | Manage every running server by default. |
| `gamePreset` | `auto` | Default preset when auto-detection fails. |
| `graceSeconds` | `300` | How long a server must stay empty before it is stopped. |
| `emptyThreshold` | `0` | Player count at or below which the server is empty. |
| `minServerUptimeSeconds` | `180` | Never stop a server within this many seconds of it being seen running. |
| `checkIntervalSeconds` | `30` | Seconds between player checks (minimum 15). |
| `stopMethod` | `console` | `console` sends a command; `agent` asks the node agent to stop the container. |
| `stopCommand` | *(preset)* | Console stop command (`stop`, `quit`, …). |
| `stopRetrySeconds` | `120` | Minimum gap between stop attempts. |
| `playerSource` | `auto` | `auto`, `a2s` or `rcon` for the count. |
| `playerCommand` / `playerRegex` | *(preset)* | RCON count command and count regex for custom games. |
| `playerListCommand` | *(preset)* | RCON command that prints the player list. |
| `banListCommand` | *(preset)* | RCON command that prints the ban list. |
| `queryHost` / `queryPort` | *(server)* | A2S endpoint override. |
| `rconHost` / `rconPort` | *(server)* | RCON endpoint override. |
| `rconPassword` | *(empty)* | RCON password; empty auto-detects from `server.properties` / `server.cfg`. |
| `welcomeEnabled` | `false` | Welcome players when first seen. |
| `welcomeMessage` | `Welcome, {player}!` | `{player}` and `{server}` are replaced. |
| `welcomeOnExisting` | `false` | Also welcome players already online when first seen. |
| `welcomeConsole` | `true` | Welcome instantly from live console output; polling is the fallback. |
| `welcomeJoinRegex` | *(preset)* | Regex matched against console lines; capture group 1 is the player name. |
| `defaultBanMinutes` | `0` | Default ban length (0 = permanent); Source/GoldSrc only. |
| `defaultBanReason` | *(empty)* | Default ban reason. |

## API

All routes are under `/api/plugins/idle-stop` with normal session or API-key auth. Reads need `server.read`; writes need `server.write` on the calling user.

```bash
BASE=https://panel.example.com/api/plugins/idle-stop
AUTH="Authorization: Bearer $CATALYST_API_KEY"

curl -H "$AUTH" "$BASE/servers"                          # all servers + state
curl -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"graceSeconds":300,"welcomeEnabled":true}' "$BASE/servers/<id>"
curl -X POST -H "$AUTH" "$BASE/servers/<id>/test"        # player probe (list or count)

curl -H "$AUTH" "$BASE/servers/<id>/players"             # live player list
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"userid":"5","reason":"afk"}' "$BASE/servers/<id>/kick"
curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Alex","steamid":"STEAM_0:1:123","minutes":0,"reason":"cheating"}' "$BASE/servers/<id>/ban"
curl -H "$AUTH" "$BASE/servers/<id>/bans"                # local + live ban lists
curl -X DELETE -H "$AUTH" "$BASE/servers/<id>/bans/<banId>"
curl -X POST -H "$AUTH" "$BASE/servers/<id>/bans/clear"

curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"confirm":"NUKE"}' "$BASE/servers/<id>/nuclear"   # clear all bans + reset session (does not kick)

curl -X POST -H "$AUTH" "$BASE/servers/<id>/clear-session"   # forget roster/welcomes/timers (bans stay)

curl -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"message":"Welcome, {player}!"}' "$BASE/welcome/broadcast"

curl -X POST -H "$AUTH" "$BASE/tick"                     # run the check cycle now
```

Ban records are stored in the plugin's `idle_stop_bans` collection and returned with `_id` for unban. Per-server settings live in `idle_stop_servers`, and the RCON password is never echoed back.

## Events

| Event | Payload |
| --- | --- |
| `idle-stop:empty` | `{ serverId, playerCount, since }` |
| `idle-stop:stopped` | `{ serverId, playerCount, method }` |
| `idle-stop:welcomed` | `{ serverId, player }` |
| `idle-stop:kicked` | `{ serverId, target, reason }` |
| `idle-stop:banned` | `{ serverId, target, minutes }` |
| `idle-stop:unbanned` | `{ serverId, target }` |
| `idle-stop:bans-cleared` | `{ serverId, count }` |
| `idle-stop:nuclear` | `{ serverId, unbanned }` |
| `idle-stop:session-cleared` | `{ serverId }` |

## Permissions

| Permission | Why |
| --- | --- |
| `server.read` | List/read servers and probe players. |
| `server.write` | Required on the caller for settings, kick/ban, clears and stops. |
| `files.read` | Read `server.properties` / `server.cfg` through the file tunnel for RCON password auto-detection. |

## Limitations

- Checks run every `checkIntervalSeconds` (minimum 15), so an empty server can stay up for up to one interval past its grace period. Welcomes are normally instant from the console; the polling fallback can be delayed by up to one interval.
- A2S cannot ban by SteamID and shows names only; Source/GoldSrc bans and SteamIDs need RCON.
- Minecraft temporary bans depend on the server/plugins; vanilla `ban` is permanent.
- If the Players panel reports a timeout or "no reachable endpoint", set `queryHost`/`queryPort` (A2S) or `rconHost`/`rconPort` to an address the panel can reach. RCON password discovery is cached for 5 minutes and bounded to 5 seconds so it never blocks a request.
- Some games report bots as players; raise `emptyThreshold` if needed.
- The `agent` stop method sends `stop_server` to the node agent; prefer the default `console` method.
