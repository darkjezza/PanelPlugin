# Idle Stop

A Catalyst panel plugin that **stops a game server once its last player leaves and the server stays empty** for a configurable grace period.

It is a panel plugin (not a game-server mod). It runs inside the panel process, checks running servers on a schedule, and asks the node to stop a server only when a player count of `0` is positively confirmed.

## How it works

The panel does not send player join/leave events to plugins, and it does not track player counts, so Idle Stop polls each managed server:

| Player source | Games | Notes |
| --- | --- | --- |
| **A2S query** | Source, CS2, GoldSrc, TF2, … | Unauthenticated UDP query; reads the player count directly from `A2S_INFO`. No password needed. |
| **Source RCON** | Minecraft Java, custom games | Runs a command (`list`) over TCP and extracts the count with a regex. |

Built-in presets:

| Preset | Count source | Stop command |
| --- | --- | --- |
| `minecraft-java` | RCON `list`, regex `There are (\d+) of a max` | `stop` |
| `source` | A2S | `quit` |
| `goldsrc` | A2S | `quit` |
| `custom` | whatever you configure | whatever you configure |

`gamePreset: auto` guesses the preset from the server's startup command and environment.

Safety behavior:

- A **query failure never stops a server.** Only a confirmed count at or below `emptyThreshold` counts as empty.
- A server must have been seen running for `minServerUptimeSeconds` before it can be stopped.
- Empty must persist for `graceSeconds` before the stop is issued.
- After a stop is issued, another stop is not issued for `stopRetrySeconds`.
- The plugin only touches servers you opt in (or all of them if you set `autoManage`).

## Requirements

- The panel must be able to reach the server's A2S/RCON host and port. If a server's `primaryIp` is `0.0.0.0` (common when the panel and node are separate machines), set `queryHost` / `rconHost` to the node's public IP.
- Minecraft: `enable-rcon=true` in `server.properties` (the plugin can auto-detect `rcon.password` through the file tunnel).
- Source/GoldSrc: nothing, as long as the UDP game port is reachable.

## Install

**Marketplace / local package**

```
my-plugin-… .catpkg.zip
```

Pack the `idle-stop/` directory and install from **Admin → Plugins → Marketplace** (or drop it into a `catalyst-plugins` checkout and rebuild the panel). Enable it in **Admin → Plugins**.

## Configure

Global defaults live in **Admin → Plugins → Idle Stop** (the manifest `config` block). Everything can be overridden per server through the API below.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for background checks. |
| `autoManage` | `false` | Manage every running server by default. Leave off and opt in per server. |
| `gamePreset` | `auto` | Default preset when auto-detection fails. |
| `graceSeconds` | `300` | How long a server must stay empty before it is stopped. |
| `emptyThreshold` | `0` | Player count at or below which the server is "empty". |
| `minServerUptimeSeconds` | `180` | Never stop a server within this many seconds of it being seen running. |
| `checkIntervalSeconds` | `60` | Minimum seconds between checks per server. |
| `stopMethod` | `console` | `console` sends a command; `agent` asks the node agent to stop the container. |
| `stopCommand` | *(preset)* | Console stop command (`stop`, `quit`, …). |
| `stopRetrySeconds` | `120` | Minimum gap between stop attempts. |
| `playerSource` | `auto` | `auto`, `a2s` or `rcon`. |
| `playerCommand` | *(preset)* | RCON command that prints the player list. |
| `playerRegex` | *(preset)* | Regex with one capture group for the count. |
| `queryHost` / `queryPort` | *(server)* | A2S endpoint override. |
| `rconHost` / `rconPort` | *(server)* | RCON endpoint override. |
| `rconPassword` | *(empty)* | RCON password. Empty auto-detects from `server.properties` / `server.cfg`. |

## API

All routes are under `/api/plugins/idle-stop` and use normal session or API-key auth. Reads require `server.read`; writes require `server.write` on the calling user.

```bash
BASE=https://panel.example.com/api/plugins/idle-stop
AUTH="Authorization: Bearer $CATALYST_API_KEY"

# List every server with its managed state and last count
curl -H "$AUTH" "$BASE/servers"

# Opt a server in and give it a 5-minute grace period
curl -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"graceSeconds":300}' "$BASE/servers/<serverId>"

# Test the player count right now (returns count + raw query output)
curl -X POST -H "$AUTH" "$BASE/servers/<serverId>/test"

# Stop a server now, for testing
curl -X POST -H "$AUTH" "$BASE/servers/<serverId>/stop"

# Run the check cycle immediately instead of waiting for the next minute
curl -X POST -H "$AUTH" "$BASE/tick"
```

Example custom (RCON) override for a game without a preset:

```json
{
  "enabled": true,
  "playerSource": "rcon",
  "playerCommand": "status",
  "playerRegex": "players\\s*:\\s*(\\d+)",
  "stopCommand": "quit",
  "rconHost": "203.0.113.10",
  "rconPort": 27015,
  "graceSeconds": 600
}
```

Per-server overrides are stored in the plugin's own collection (`idle_stop_servers`) and never echo the RCON password back.

## Events

| Event | Payload |
| --- | --- |
| `idle-stop:empty` | `{ serverId, playerCount, since }` — first time a server is seen empty. |
| `idle-stop:stopped` | `{ serverId, playerCount, method }` — after a stop is issued. |

## Permissions

| Permission | Why |
| --- | --- |
| `server.read` | List and read servers to check status and ports. |
| `server.write` | Required on the caller for settings/stop routes. |
| `files.read` | Read `server.properties` / `server.cfg` through the file tunnel to auto-detect the RCON password. |

## Limitations

- Checks run at most **once per minute** (the panel's task scheduler is minute-granular), so a server can stay up for up to a minute past its grace period.
- RCON/A2S cannot see players if the query port is not reachable from the panel; set `queryHost`/`rconHost` when the panel and node are separate machines.
- Some games report bots as players; raise `emptyThreshold` if needed.
- The `agent` stop method sends `stop_server` to the node agent. Prefer the default `console` method, which uses the game's own graceful shutdown command.
