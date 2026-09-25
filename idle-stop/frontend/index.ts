/**
 * Idle Stop & Player Admin — frontend tabs.
 *
 * Deliberately hook-free. Marketplace installs load the self-contained
 * `frontend.mjs`, which runs on its own React copy where hooks throw; a
 * compiled checkout shares the panel React instead. A plain default export
 * with a `manifest` is accepted by both loaders.
 *
 * The tab body is a callback ref that mounts a small imperative UI.
 */

import React from 'react';

const API_BASE = '/api/plugins/idle-stop';

type Dict = Record<string, any>;

async function api(path: string, options: Dict = {}): Promise<Dict> {
  const res = await fetch(API_BASE + path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let json: Dict | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || (json && json.success === false)) {
    throw new Error((json && json.error) || `HTTP ${res.status}`);
  }
  return json || {};
}

function el(tag: string, attrs: Dict = {}, children: any = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') node.className = value as string;
    else if (key === 'text') node.textContent = String(value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'checked' || key === 'disabled') (node as any)[key] = Boolean(value);
    else node.setAttribute(key, value as string);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child === undefined || child === null) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function btnClass(tone: string): string {
  const base = 'px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  if (tone === 'danger') return `${base} bg-red-600 hover:bg-red-700 text-white`;
  if (tone === 'muted') return `${base} bg-gray-700 hover:bg-gray-600 text-gray-100`;
  return `${base} bg-primary-600 hover:bg-primary-700 text-white`;
}

function button(label: string, onClick: () => void, tone = 'primary'): HTMLButtonElement {
  return el('button', { className: btnClass(tone), text: label, onClick }) as HTMLButtonElement;
}

function badge(text: string, tone: string): HTMLElement {
  return el('span', { className: `inline-block px-2 py-0.5 rounded text-xs font-medium ${tone}`, text });
}

function statusTone(status: string): string {
  if (status === 'running') return 'bg-green-500/20 text-green-400';
  if (status === 'stopped') return 'bg-gray-600/30 text-gray-300';
  return 'bg-yellow-500/20 text-yellow-400';
}

function card(title: string, body: any[]): HTMLElement {
  return el('div', { className: 'bg-gray-800 rounded-lg p-6 border border-gray-700' }, [
    el('h3', { className: 'text-lg font-semibold mb-4', text: title }),
    ...body,
  ]);
}

function row(label: string, value: string): HTMLElement {
  return el('div', { className: 'flex justify-between py-1 border-b border-gray-700/50 last:border-0' }, [
    el('span', { className: 'text-gray-400 text-sm', text: label }),
    el('span', { className: 'text-sm font-mono', text: value }),
  ]);
}

function inputEl(attrs: Dict): HTMLInputElement {
  return el('input', {
    className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary-500',
    ...attrs,
  }) as HTMLInputElement;
}

function selectEl(values: string[], selected: string): HTMLSelectElement {
  const select = el('select', { className: 'w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white text-sm' }) as HTMLSelectElement;
  for (const value of values) select.appendChild(el('option', { value, text: value }) as HTMLOptionElement);
  select.value = selected;
  return select;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { className: 'block' }, [
    el('span', { className: 'block text-sm font-medium text-gray-300 mb-1', text: label }),
    control,
  ]);
}

function table(headers: string[], rows: HTMLElement[]): HTMLElement {
  return el('div', { className: 'overflow-x-auto' }, [
    el('table', { className: 'min-w-full' }, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { className: 'text-left text-xs uppercase text-gray-400 px-3 py-2', text: h })))]),
      el('tbody', {}, rows),
    ]),
  ]);
}

const fmt = (ts?: string | number | null) => (ts ? new Date(ts).toLocaleString() : '—');

function playerLabel(p: Dict): string {
  return p.name || p.steamid || (p.userid ? `#${p.userid}` : 'unknown');
}

// ------------------------------------------------------------- admin tab ---

function mountAdmin(root: HTMLElement): void {
  const status = el('div', { className: 'text-sm text-gray-400' });
  const tableWrap = el('div', { className: 'overflow-x-auto' });

  async function refresh(): Promise<void> {
    status.textContent = 'Loading…';
    try {
      const data = await api('/servers');
      render(data.servers || []);
      const managed = (data.servers || []).filter((s: Dict) => s.managed).length;
      status.textContent = `${data.count || 0} server(s), ${managed} managed`;
    } catch (err: any) {
      status.textContent = `Error: ${err.message}`;
    }
  }

  function render(servers: Dict[]): void {
    tableWrap.innerHTML = '';
    if (!servers.length) {
      tableWrap.appendChild(el('p', { className: 'text-gray-400', text: 'No servers found.' }));
      return;
    }
    const rows = servers.map((s) => {
      const toggle = button(s.managed ? 'Disable' : 'Enable', async () => {
        try {
          await api(`/servers/${encodeURIComponent(s.id)}`, { method: 'PUT', body: { enabled: !s.managed } });
          await refresh();
        } catch (err: any) {
          status.textContent = `Error: ${err.message}`;
        }
      }, s.managed ? 'danger' : 'primary');

      const test = button('Test', async () => {
        test.disabled = true;
        const prev = test.textContent;
        test.textContent = 'Testing…';
        try {
          const r = await api(`/servers/${encodeURIComponent(s.id)}/test`, { method: 'POST' });
          status.textContent = `${s.name}: ${r.count} player(s) via ${r.source}${r.listError ? ` (list: ${r.listError})` : ''}`;
        } catch (err: any) {
          status.textContent = `${s.name}: ${err.message}`;
        } finally {
          test.disabled = false;
          test.textContent = prev;
        }
      }, 'muted');

      return el('tr', { className: 'border-t border-gray-700' }, [
        el('td', { className: 'px-3 py-2 text-sm', text: s.name }),
        el('td', { className: 'px-3 py-2' }, [badge(s.status, statusTone(s.status))]),
        el('td', { className: 'px-3 py-2' }, [badge(s.managed ? 'yes' : 'no', s.managed ? 'bg-green-500/20 text-green-400' : 'bg-gray-600/30 text-gray-400')]),
        el('td', { className: 'px-3 py-2 text-sm font-mono', text: s.state && s.state.lastCount != null ? String(s.state.lastCount) : '—' }),
        el('td', { className: 'px-3 py-2 text-sm text-gray-400', text: s.state ? fmt(s.state.idleSince) : '—' }),
        el('td', { className: 'px-3 py-2 text-xs text-red-400', text: (s.state && s.state.lastError) || '' }),
        el('td', { className: 'px-3 py-2 text-right space-x-2' }, [test, toggle]),
      ]);
    });
    tableWrap.appendChild(table(['Server', 'Status', 'Managed', 'Players', 'Empty since', 'Last error', ''], rows));
  }

  const runCheck = button('Run check now', async () => {
    runCheck.disabled = true;
    try {
      await api('/tick', { method: 'POST' });
      await refresh();
    } catch (err: any) {
      status.textContent = `Error: ${err.message}`;
    } finally {
      runCheck.disabled = false;
    }
  }, 'muted');

  const broadcast = button('Broadcast welcome', async () => {
    const message = window.prompt('Message to broadcast to every running server:', 'Welcome, {player}!');
    if (message === null) return;
    broadcast.disabled = true;
    try {
      const r = await api('/welcome/broadcast', { method: 'POST', body: { message } });
      status.textContent = `Broadcast sent to ${r.sent.length} server(s)${r.errors.length ? `; errors: ${r.errors.join('; ')}` : ''}`;
    } catch (err: any) {
      status.textContent = `Error: ${err.message}`;
    } finally {
      broadcast.disabled = false;
    }
  }, 'muted');

  root.appendChild(el('h2', { className: 'text-2xl font-bold mb-1', text: 'Idle Stop & Player Admin' }));
  root.appendChild(el('p', { className: 'text-gray-400 mb-4', text: 'Auto-stop empty servers, manage players, bans and welcome messages. Opt servers in below.' }));
  root.appendChild(el('div', { className: 'flex items-center gap-3 mb-4' }, [button('Refresh', refresh, 'muted'), runCheck, broadcast, status]));
  root.appendChild(tableWrap);
  refresh();
}

// ------------------------------------------------------------ server tab ---

function mountServer(root: HTMLElement, serverId: string): void {
  const status = el('div', { className: 'text-sm text-gray-400' });
  const stateHost = el('div');
  const playersHost = el('div');
  const bansHost = el('div');
  const settingsHost = el('div');
  const nukeHost = el('div');
  let current: Dict | null = null;

  root.appendChild(el('h2', { className: 'text-2xl font-bold mb-1', text: 'Idle Stop & Player Admin' }));
  root.appendChild(el('p', { className: 'text-gray-400 mb-1', text: 'Empty-server auto-stop, players, bans and welcome for this server.' }));
  root.appendChild(el('div', { className: 'mb-4' }, [status]));
  root.appendChild(el('div', { className: 'space-y-6' }, [stateHost, playersHost, bansHost, settingsHost, nukeHost]));

  const settings = (): Dict => (current && current.settings) || {};

  async function load(): Promise<void> {
    status.textContent = 'Loading…';
    try {
      const data = await api(`/servers/${encodeURIComponent(serverId)}`);
      current = data.server;
      renderState();
      renderSettings();
      renderNuke();
      status.textContent = '';
      await Promise.all([refreshPlayers(), refreshBans()]);
    } catch (err: any) {
      status.textContent = `Error: ${err.message}`;
    }
  }

  function renderState(): void {
    const s = current as Dict;
    const st = s.state || {};
    stateHost.innerHTML = '';
    stateHost.appendChild(card(`Current state — ${s.name || s.id}`, [
      row('Status', s.status || '—'),
      row('Managed', s.managed ? 'yes' : 'no'),
      row('Preset', `${settings().preset || '—'} (${settings().playerSource || '—'})`),
      row('RCON password', settings().rconPasswordSet ? 'set' : 'not set'),
      row('Players', st.lastCount == null ? '—' : `${st.lastCount}${st.lastSource ? ` (${st.lastSource})` : ''}`),
      row('Empty since', fmt(st.idleSince)),
      row('Last stop', fmt(st.lastStopAt)),
      row('Last welcome', fmt(st.lastWelcomeAt)),
      row('Last error', st.lastError || '—'),
    ]));
  }

  // ------------------------------------------------------------ players ---

  async function refreshPlayers(): Promise<void> {
    playersHost.innerHTML = '';
    const host = el('div', { className: 'text-sm text-gray-400', text: 'Loading players…' });
    playersHost.appendChild(host);
    try {
      const data = await api(`/servers/${encodeURIComponent(serverId)}/players`);
      const players: Dict[] = data.players || [];
      const body: any[] = [];

      const refresh = button('Refresh', () => refreshPlayers(), 'muted');
      body.push(el('div', { className: 'flex items-center gap-3 mb-3' }, [refresh, el('span', { className: 'text-sm text-gray-400', text: `${data.count} online via ${data.source} (${data.mode})` })]));
      if (data.listError) body.push(el('p', { className: 'text-xs text-yellow-400 mb-2', text: `List warning: ${data.listError}` }));
      if (data.authoritative === false) body.push(el('p', { className: 'text-xs text-yellow-400 mb-2', text: 'Roster is not authoritative yet: it becomes complete the next time this server starts under the panel. Auto-stop is paused until then.' }));

      if (data.mode === 'list' && players.length) {
        const rows = players.map((p) => {
          const kick = button('Kick', async () => {
            if (!window.confirm(`Kick ${playerLabel(p)}?`)) return;
            kick.disabled = true;
            try {
              await api(`/servers/${encodeURIComponent(serverId)}/kick`, { method: 'POST', body: { name: p.name, userid: p.userid, steamid: p.steamid } });
              await refreshPlayers();
            } catch (err: any) {
              host.textContent = `Error: ${err.message}`;
            }
          }, 'muted');

          const ban = button('Ban', async () => {
            const mins = window.prompt('Ban length in minutes (0 = permanent):', String(settings().defaultBanMinutes ?? 0));
            if (mins === null) return;
            const reason = window.prompt('Reason:', settings().defaultBanReason || '');
            if (reason === null) return;
            ban.disabled = true;
            try {
              await api(`/servers/${encodeURIComponent(serverId)}/ban`, {
                method: 'POST',
                body: { name: p.name, userid: p.userid, steamid: p.steamid, minutes: Number(mins), reason },
              });
              await Promise.all([refreshPlayers(), refreshBans()]);
            } catch (err: any) {
              host.textContent = `Error: ${err.message}`;
            } finally {
              ban.disabled = false;
            }
          }, 'danger');

          const primary = p.name || p.steamid || (p.userid ? `#${p.userid}` : 'unknown');
          const detail = p.name ? (p.steamid || (p.userid ? `#${p.userid}` : '—')) : (p.userid ? `#${p.userid}` : '—');
          return el('tr', { className: 'border-t border-gray-700' }, [
            el('td', { className: 'px-3 py-2 text-sm', text: primary }),
            el('td', { className: 'px-3 py-2 text-xs font-mono text-gray-400', text: detail }),
            el('td', { className: 'px-3 py-2 text-right space-x-2' }, [kick, ban]),
          ]);
        });
        body.push(table(['Player', 'ID', ''], rows));
      } else {
        body.push(el('p', { className: 'text-sm text-gray-400', text: `${data.count} player(s) online. Player names are unavailable for this preset/source; only counts are shown.` }));
      }

      playersHost.innerHTML = '';
      playersHost.appendChild(card('Players', body));
    } catch (err: any) {
      playersHost.innerHTML = '';
      playersHost.appendChild(card('Players', [
        el('div', { className: 'flex items-center gap-3' }, [button('Refresh', () => refreshPlayers(), 'muted'), el('span', { className: 'text-sm text-red-400', text: `Error: ${err.message}` })]),
      ]));
    }
  }

  // --------------------------------------------------------------- bans ---

  async function refreshBans(): Promise<void> {
    bansHost.innerHTML = '';
    const host = el('div', { className: 'text-sm text-gray-400', text: 'Loading bans…' });
    bansHost.appendChild(host);
    try {
      const data = await api(`/servers/${encodeURIComponent(serverId)}/bans`);
      const local: Dict[] = data.local || [];
      const remote: Dict = data.remote || {};
      const body: any[] = [];

      const clearLocal = button('Clear local bans', async () => {
        if (!window.confirm('Delete all ban records stored by this plugin for this server? (Server bans are not removed.)')) return;
        clearLocal.disabled = true;
        try {
          await api(`/servers/${encodeURIComponent(serverId)}/bans/clear`, { method: 'POST' });
          await refreshBans();
        } catch (err: any) {
          host.textContent = `Error: ${err.message}`;
        } finally {
          clearLocal.disabled = false;
        }
      }, 'muted');

      const clearBanSession = button('Clear kick/ban session', async () => {
        if (!window.confirm("Clear the server's session kicks and in-memory bans, and delete this plugin's ban records for this server?")) return;
        clearBanSession.disabled = true;
        try {
          const r = await api(`/servers/${encodeURIComponent(serverId)}/clear-ban-session`, { method: 'POST' });
          const res = r.result || {};
          status.textContent = `Kick/ban session cleared: ${res.localCleared} record(s)${res.kicksCleared ? ', kicks cleared' : ''}${res.bansCleared ? ', bans cleared' : ''}${res.errors && res.errors.length ? `; errors: ${res.errors.join('; ')}` : ''}`;
          await refreshBans();
        } catch (err: any) {
          status.textContent = `Error: ${err.message}`;
        } finally {
          clearBanSession.disabled = false;
        }
      }, 'danger');

      body.push(el('div', { className: 'flex items-center gap-3 mb-3' }, [button('Refresh', () => refreshBans(), 'muted'), clearBanSession, clearLocal, el('span', { className: 'text-sm text-gray-400', text: `${local.length} local ban(s)` })]));

      if (local.length) {
        const rows = local.map((b) => {
          const unban = button('Unban', async () => {
            if (!window.confirm(`Unban ${b.target}?`)) return;
            unban.disabled = true;
            try {
              await api(`/servers/${encodeURIComponent(serverId)}/bans/${encodeURIComponent(b._id)}`, { method: 'DELETE' });
              await refreshBans();
            } catch (err: any) {
              host.textContent = `Error: ${err.message}`;
            } finally {
              unban.disabled = false;
            }
          }, 'muted');
          return el('tr', { className: 'border-t border-gray-700' }, [
            el('td', { className: 'px-3 py-2 text-sm', text: b.target || '—' }),
            el('td', { className: 'px-3 py-2 text-sm text-gray-400', text: b.reason || '—' }),
            el('td', { className: 'px-3 py-2 text-xs text-gray-400', text: b.minutes === 0 ? 'permanent' : `${b.minutes}m` }),
            el('td', { className: 'px-3 py-2 text-xs text-gray-400', text: fmt(b.createdAt) }),
            el('td', { className: 'px-3 py-2 text-right' }, [unban]),
          ]);
        });
        body.push(table(['Target', 'Reason', 'Length', 'Created', ''], rows));
      } else {
        body.push(el('p', { className: 'text-sm text-gray-400 mb-3', text: 'No bans recorded by this plugin.' }));
      }

      body.push(el('p', { className: 'text-xs uppercase text-gray-500 mt-4 mb-1', text: 'From the server' }));
      if (remote.ok) {
        body.push(remote.bans && remote.bans.length
          ? el('div', { className: 'flex flex-wrap gap-2' }, remote.bans.map((b: Dict) => badge(b.target, 'bg-red-500/20 text-red-400')))
          : el('p', { className: 'text-sm text-gray-400', text: 'The server reports no bans.' }));
      } else {
        body.push(el('p', { className: 'text-sm text-yellow-400', text: `Unavailable: ${remote.error || 'unknown'}` }));
      }

      bansHost.innerHTML = '';
      bansHost.appendChild(card('Bans', body));
    } catch (err: any) {
      bansHost.innerHTML = '';
      bansHost.appendChild(card('Bans', [
        el('div', { className: 'flex items-center gap-3' }, [button('Refresh', () => refreshBans(), 'muted'), el('span', { className: 'text-sm text-red-400', text: `Error: ${err.message}` })]),
      ]));
    }
  }

  // ----------------------------------------------------------- settings ---

  function renderSettings(): void {
    const st = settings();
    const s = current as Dict;
    settingsHost.innerHTML = '';

    const enabled = inputEl({ type: 'checkbox' }) as HTMLInputElement;
    enabled.checked = Boolean(s.managed);
    const grace = inputEl({ type: 'number', min: '0', value: String(st.graceSeconds ?? 300) });
    const threshold = inputEl({ type: 'number', min: '0', value: String(st.emptyThreshold ?? 0) });
    const uptime = inputEl({ type: 'number', min: '0', value: String(st.minServerUptimeSeconds ?? 180) });
    const interval = inputEl({ type: 'number', min: '15', value: String(st.checkIntervalSeconds ?? 30) });
    const preset = selectEl(['auto', 'minecraft-java', 'source', 'goldsrc', 'valheim', 'palworld', 'project-zomboid', 'nuclear-option', 'custom'], st.preset || 'auto');
    const stopMethod = selectEl(['console', 'agent'], st.stopMethod || 'console');
    const stopCommand = inputEl({ type: 'text', value: st.stopCommand || '' });
    const playerSource = selectEl(['auto', 'a2s', 'rcon'], st.playerSource || 'auto');
    const playerListCommand = inputEl({ type: 'text', value: st.playerListCommand || '', placeholder: 'status / list' });
    const banListCommand = inputEl({ type: 'text', value: st.banListCommand || '', placeholder: 'listid / banlist' });
    const queryHost = inputEl({ type: 'text', value: st.queryHost || '' });
    const queryPort = inputEl({ type: 'number', min: '0', value: String(st.queryPort ?? 0) });
    const rconHost = inputEl({ type: 'text', value: st.rconHost || '' });
    const rconPort = inputEl({ type: 'number', min: '0', value: String(st.rconPort ?? 0) });
    const rconPortOffset = inputEl({ type: 'number', min: '0', value: String(st.rconPortOffset ?? 0) });
    const rconPassword = inputEl({ type: 'password', placeholder: st.rconPasswordSet ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (stored \u2014 type to replace)' : 'not set' });
    const steamApiKey = inputEl({ type: 'password', placeholder: st.steamApiKeySet ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (stored)' : 'Steam Web API key' });
    const welcomeEnabled = inputEl({ type: 'checkbox' }) as HTMLInputElement;
    welcomeEnabled.checked = Boolean(st.welcomeEnabled);
    const welcomeMessage = inputEl({ type: 'text', value: st.welcomeMessage || 'Welcome, {player}!' });
    const welcomeOnExisting = inputEl({ type: 'checkbox' }) as HTMLInputElement;
    welcomeOnExisting.checked = Boolean(st.welcomeOnExisting);
    const welcomeConsole = inputEl({ type: 'checkbox' }) as HTMLInputElement;
    welcomeConsole.checked = st.welcomeConsole !== false;
    const welcomeJoinRegex = inputEl({ type: 'text', value: st.welcomeJoinRegex || '', placeholder: 'preset join pattern' });
    const banMinutes = inputEl({ type: 'number', min: '0', value: String(st.defaultBanMinutes ?? 0) });
    const banReason = inputEl({ type: 'text', value: st.defaultBanReason || '' });

    const grid = el('div', { className: 'grid grid-cols-1 md:grid-cols-2 gap-4' }, [
      field('Enabled for this server', enabled),
      field('Game preset', preset),
      field('Grace period (seconds)', grace),
      field('Empty threshold (players)', threshold),
      field('Min uptime (seconds)', uptime),
      field('Check interval (seconds)', interval),
      field('Stop method', stopMethod),
      field('Stop command', stopCommand),
      field('Player source', playerSource),
      field('Player list command', playerListCommand),
      field('Ban list command', banListCommand),
      field('Query host (A2S)', queryHost),
      field('Query port (A2S)', queryPort),
      field('RCON host', rconHost),
      field('RCON port', rconPort),
      field('RCON port offset', rconPortOffset),
      field('RCON password', rconPassword),
      field('Steam API key (SteamID names)', steamApiKey),
      field('Welcome players (on join)', welcomeEnabled),
      field('Welcome message', welcomeMessage),
      field('Instant welcome from console', welcomeConsole),
      field('Join regex (console)', welcomeJoinRegex),
      field('Welcome already-online players', welcomeOnExisting),
      field('Default ban minutes', banMinutes),
      field('Default ban reason', banReason),
    ]);

    const save = button('Save', async () => {
      save.disabled = true;
      status.textContent = 'Saving…';
      try {
        const body: Dict = {
          enabled: enabled.checked,
          gamePreset: preset.value,
          graceSeconds: Number(grace.value),
          emptyThreshold: Number(threshold.value),
          minServerUptimeSeconds: Number(uptime.value),
          checkIntervalSeconds: Number(interval.value),
          stopMethod: stopMethod.value,
          stopCommand: stopCommand.value,
          playerSource: playerSource.value,
          playerListCommand: playerListCommand.value,
          banListCommand: banListCommand.value,
          queryHost: queryHost.value,
          queryPort: Number(queryPort.value),
          rconHost: rconHost.value,
          rconPort: Number(rconPort.value),
          rconPortOffset: Number(rconPortOffset.value),
          welcomeEnabled: welcomeEnabled.checked,
          welcomeMessage: welcomeMessage.value,
          welcomeOnExisting: welcomeOnExisting.checked,
          welcomeConsole: welcomeConsole.checked,
          welcomeJoinRegex: welcomeJoinRegex.value,
          defaultBanMinutes: Number(banMinutes.value),
          defaultBanReason: banReason.value,
        };
        if (rconPassword.value) body.rconPassword = rconPassword.value;
        if (steamApiKey.value) body.steamApiKey = steamApiKey.value;
        await api(`/servers/${encodeURIComponent(serverId)}`, { method: 'PUT', body });
        await load();
        status.textContent = 'Saved.';
      } catch (err: any) {
        status.textContent = `Error: ${err.message}`;
      } finally {
        save.disabled = false;
      }
    });

    const broadcast = button('Send welcome now', async () => {
      try {
        const r = await api('/welcome/broadcast', { method: 'POST', body: { serverId, message: welcomeMessage.value } });
        status.textContent = r.sent.length ? 'Welcome broadcast sent.' : `Not sent: ${(r.errors || []).join('; ') || 'server not running'}`;
      } catch (err: any) {
        status.textContent = `Error: ${err.message}`;
      }
    }, 'muted');

    settingsHost.appendChild(card('Settings', [
      grid,
      el('p', { className: 'text-xs text-gray-400 pt-3', text: 'The RCON password is never shown once saved. Type a new value to replace it, or leave it blank to keep the current one.' }),
      el('div', { className: 'flex items-center gap-3 pt-4' }, [save, broadcast, status]),
    ]));
  }

  // ------------------------------------------------------------ nuclear ---

  function renderNuke(): void {
    nukeHost.innerHTML = '';
    const confirmInput = inputEl({ type: 'text', placeholder: 'Type NUKE to confirm' });
    const clearSession = button('Clear session', async () => {
      if (!window.confirm("Forget this server's player roster, welcomes and idle timers? Bans are not touched.")) return;
      clearSession.disabled = true;
      try {
        await api(`/servers/${encodeURIComponent(serverId)}/clear-session`, { method: 'POST' });
        status.textContent = 'Session cleared.';
        await Promise.all([refreshPlayers(), refreshBans()]);
      } catch (err: any) {
        status.textContent = `Error: ${err.message}`;
      } finally {
        clearSession.disabled = false;
      }
    }, 'muted');

    const run = button('Clear bans & session', async () => {
      if (confirmInput.value !== 'NUKE') {
        status.textContent = 'Type NUKE to confirm the nuclear reset.';
        return;
      }
      if (!window.confirm(`Nuclear reset on ${(current as Dict).name}: remove all bans and clear the session? Online players are not kicked.`)) return;
      run.disabled = true;
      status.textContent = 'Running nuclear reset…';
      try {
        const r = await api(`/servers/${encodeURIComponent(serverId)}/nuclear`, { method: 'POST', body: { confirm: 'NUKE' } });
        const res = r.result || {};
        status.textContent = `Nuclear done: ${res.unbanned} unbanned, ${res.cleared} local record(s) cleared, session reset${res.errors && res.errors.length ? `; errors: ${res.errors.join('; ')}` : ''}`;
        await Promise.all([refreshPlayers(), refreshBans()]);
      } catch (err: any) {
        status.textContent = `Error: ${err.message}`;
      } finally {
        run.disabled = false;
        confirmInput.value = '';
      }
    }, 'danger');

    nukeHost.appendChild(card('Danger zone', [
      el('p', { className: 'text-sm text-red-300 mb-3', text: 'Removes bans from the server, deletes this plugin\u2019s ban records, and forgets this server\u2019s player session. Online players are not kicked. This cannot be undone.' }),
      el('div', { className: 'flex flex-col sm:flex-row gap-3' }, [
        el('div', { className: 'flex-1' }, [confirmInput]),
        run,
      ]),
      el('div', { className: 'flex items-center gap-3 pt-3' }, [
        clearSession,
        el('span', { className: 'text-xs text-gray-400', text: 'Clear session only: forget the roster, welcomes and timers (bans stay).' }),
      ]),
    ]));
  }

  load();
}

// ------------------------------------------------------------------ tab ---

function IdleStopTab(props: { serverId?: string }): React.ReactElement {
  const serverId = props && props.serverId;
  const setup = (node: HTMLElement | null): void => {
    if (!node || (node as any).__idleStopMounted) return;
    (node as any).__idleStopMounted = true;
    if (serverId) mountServer(node, serverId);
    else mountAdmin(node);
  };
  return React.createElement('div', { ref: setup, className: 'space-y-6' });
}

export default {
  manifest: {
    name: 'idle-stop',
    version: '1.10.9',
    displayName: 'Idle Stop & Player Admin',
    description: 'Auto-stop empty servers, plus player list, kick, ban, ban list and welcome messages.',
    author: 'SpiritNetworks',
  },
  tabs: [
    {
      id: 'idle-stop-admin',
      label: 'Idle Stop & Player Admin',
      icon: 'Moon',
      component: IdleStopTab,
      location: 'admin',
      order: 100,
      requiredPermissions: ['server.read'],
    },
    {
      id: 'idle-stop-server',
      label: 'Idle Stop & Player Admin',
      icon: 'Moon',
      component: IdleStopTab,
      location: 'server',
      order: 100,
      requiredPermissions: ['server.read'],
    },
  ],
};
