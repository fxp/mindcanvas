// Admin backend: token-gated. Manages the LLM config (persisted) and all meetings
// (start / end / reopen / delete / inspect). Ending a meeting is admin-only.

(function () {
  const $ = (id) => document.getElementById(id);
  let token = localStorage.getItem('mc_auth') || ''; // shared session token (admin role)
  let refreshTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function kb(b) { return b ? (b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : Math.round(b / 1024) + 'KB') : '0'; }

  async function adminFetch(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'x-auth-token': token, ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    if (res.status === 401) { showLogin('请重新登录'); throw new Error('unauthorized'); }
    return res;
  }

  function showLogin(msg) {
    clearInterval(refreshTimer);
    $('login').style.display = 'block';
    $('dash').style.display = 'none';
    $('logoutBtn').style.display = 'none';
    if (msg) $('loginStatus').textContent = msg;
  }
  function showDash() {
    $('login').style.display = 'none';
    $('dash').style.display = 'block';
    $('logoutBtn').style.display = '';
    loadConfig();
    loadMeetings();
    loadUsers();
    loadSessions();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(loadMeetings, 5000);
  }

  // ---- 会话留痕（按频道 + session） ----
  function dl(filename, blob) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  async function loadSessions() {
    let d;
    try { d = await (await adminFetch('/api/admin/sessions')).json(); } catch { return; }
    const rows = (d.sessions || []).map((s) => {
      const st = s.stats ? (typeof s.stats === 'string' ? JSON.parse(s.stats) : s.stats) : {};
      const scale = st.points != null ? `${st.sections || 0}节·${st.points || 0}点·${st.commentCount || 0}评·${st.participants || 0}人` : '—';
      const au = s.audio && s.audio.n ? `${s.audio.n}/${kb(s.audio.bytes)}` : '—';
      const live = s.live ? ' <span class="st live">LIVE</span>' : '';
      return `<tr>
        <td class="mono">${esc(s.room)}</td>
        <td class="mono" style="font-size:11px">${esc(String(s.id).slice(0, 12))}</td>
        <td>${esc((s.title || '未命名').slice(0, 18))}</td>
        <td><span class="st ${s.status === 'ended' ? 'ended' : 'active'}">${s.status === 'ended' ? '已结束' : '进行中'}</span>${live}</td>
        <td class="mono">${fmtTime(s.started_at)}</td>
        <td class="mono">${esc(scale)}</td>
        <td class="mono">${s.events}</td>
        <td class="mono">${au}</td>
        <td>
          <button class="actbtn" data-sx="export" data-id="${esc(s.id)}">导出</button>
          <button class="actbtn" data-sx="events" data-id="${esc(s.id)}">事件</button>
          <button class="actbtn danger" data-sx="del" data-id="${esc(s.id)}">删除</button>
        </td></tr>`;
    }).join('');
    $('sessions').innerHTML = rows || '<tr><td colspan="9" style="color:var(--faint);padding:14px">暂无会话</td></tr>';
    $('sessions').querySelectorAll('button[data-sx]').forEach((b) => b.addEventListener('click', () => sessionAction(b.getAttribute('data-sx'), b.getAttribute('data-id'))));
  }
  async function sessionAction(act, id) {
    try {
      if (act === 'export') {
        const blob = await (await adminFetch('/api/admin/session/export?id=' + encodeURIComponent(id))).blob();
        dl('session-' + id + '.json', blob); toast('已导出');
      } else if (act === 'events') {
        const d = await (await adminFetch('/api/admin/session/events?id=' + encodeURIComponent(id) + '&limit=40')).json();
        const lines = (d.events || []).map((e) => new Date(e.t).toLocaleTimeString() + ' · ' + e.type + ' · ' + JSON.stringify(e.payload).slice(0, 70));
        alert(lines.length ? '最近 ' + lines.length + ' 条事件：\n\n' + lines.join('\n') : '该会话暂无事件');
      } else if (act === 'del') {
        if (!confirm('删除该会话留痕（含事件与音频）？不可恢复。')) return;
        await adminFetch('/api/admin/session', { method: 'DELETE', body: JSON.stringify({ id }) });
        toast('已删除'); loadSessions();
      }
    } catch (e) { toast('失败：' + e.message); }
  }

  // verify the stored token belongs to an admin
  async function verifyToken() {
    if (!token) return false;
    try {
      const res = await fetch('/api/auth/me', { headers: { 'x-auth-token': token } });
      if (!res.ok) return false;
      const d = await res.json();
      return d.ok && d.role === 'admin';
    } catch { return false; }
  }
  async function login(username, password) {
    $('loginStatus').textContent = '登录中…';
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const d = await res.json();
      if (!d.ok) { showLogin(d.error || '登录失败'); return; }
      if (d.role !== 'admin') { showLogin('该账户不是管理员'); return; }
      token = d.token;
      localStorage.setItem('mc_auth', token);
      showDash();
    } catch (e) { showLogin('请求失败：' + e.message); }
  }

  // ---- config ----
  async function loadConfig() {
    try {
      const d = await (await adminFetch('/api/admin/config')).json();
      const b = $('engineBadge');
      b.textContent = d.info.label || '启发式综合';
      b.className = 'badge ' + (d.info.enabled ? 'on' : 'off');
      $('cfgStatus').textContent = d.persisted ? '✓ 已持久化保存' : '';
    } catch { /* */ }
  }
  $('cfgSave').addEventListener('click', async () => {
    const body = JSON.stringify({ provider: $('cfgProvider').value, key: $('cfgKey').value.trim(), model: $('cfgModel').value.trim() || undefined, endpoint: $('cfgEndpoint').value.trim() || undefined });
    if (!$('cfgKey').value.trim()) { $('cfgStatus').textContent = '请填写 key'; return; }
    $('cfgStatus').textContent = '校验中…';
    try {
      const d = await (await adminFetch('/api/admin/config', { method: 'POST', body })).json();
      $('cfgKey').value = '';
      if (d.valid) { $('cfgStatus').textContent = '✓ 已保存并持久化 · ' + d.info.label; loadConfig(); }
      else $('cfgStatus').textContent = '⚠ 校验失败：' + (d.error || '');
    } catch (e) { $('cfgStatus').textContent = '失败：' + e.message; }
  });
  $('cfgClear').addEventListener('click', async () => {
    if (!confirm('清除服务器上已保存的 key？')) return;
    await adminFetch('/api/admin/config', { method: 'DELETE' });
    $('cfgStatus').textContent = '已清除';
    loadConfig();
  });

  // ---- meetings ----
  async function loadMeetings() {
    let d;
    try { d = await (await adminFetch('/api/admin/meetings')).json(); } catch { return; }
    const rows = (d.meetings || []).map((m) => {
      const st = m.stats || {};
      const scale = st.points != null ? `${st.sections || 0}节 · ${st.points || 0}点 · ${st.commentCount || 0}评 · ${st.participants || 0}人` : '—';
      const audio = m.audio && m.audio.n ? `${m.audio.n}段/${kb(m.audio.bytes)}` : '—';
      const statusCls = m.status === 'ended' ? 'ended' : 'active';
      const live = m.live ? ' <span class="st live">LIVE</span>' : '';
      const acts = [
        `<a class="actbtn" href="/?room=${encodeURIComponent(m.room)}" target="_blank">画布</a>`,
        `<a class="actbtn" href="/screen?room=${encodeURIComponent(m.room)}" target="_blank">大屏</a>`,
        m.status === 'ended'
          ? `<button class="actbtn" data-act="reopen" data-room="${esc(m.room)}">重开</button>`
          : `<button class="actbtn" data-act="end" data-room="${esc(m.room)}">结束</button>`,
        m.audio && m.audio.n ? `<a class="actbtn" href="/api/admin/meeting/audio?room=${encodeURIComponent(m.room)}&seq=1" >音频↓</a>` : '',
        `<button class="actbtn danger" data-act="del" data-room="${esc(m.room)}">删除</button>`,
      ].join('');
      return `<tr>
        <td class="mono">${esc(m.room)}</td>
        <td>${esc((m.title || '未命名').slice(0, 30))}</td>
        <td><span class="st ${statusCls}">${m.status === 'ended' ? '已结束' : '进行中'}</span>${live}</td>
        <td class="mono">${esc(scale)}</td>
        <td class="mono">${audio}</td>
        <td class="mono">${fmtTime(m.updated_at)}</td>
        <td>${acts}</td>
      </tr>`;
    }).join('');
    $('meetings').innerHTML = rows || '<tr><td colspan="7" style="color:var(--faint);padding:16px">暂无会议</td></tr>';
    $('meetings').querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => doAction(b.getAttribute('data-act'), b.getAttribute('data-room'))));
  }

  async function doAction(act, room) {
    if (act === 'end' && !confirm(`结束会议「${room}」？结束后将锁定为只读，仅后台可重开。`)) return;
    if (act === 'del' && !confirm(`彻底删除会议「${room}」及其音频数据？不可恢复。`)) return;
    try {
      if (act === 'end') await adminFetch('/api/admin/meeting/end', { method: 'POST', body: JSON.stringify({ room }) });
      else if (act === 'reopen') await adminFetch('/api/admin/meeting/reopen', { method: 'POST', body: JSON.stringify({ room }) });
      else if (act === 'del') await adminFetch('/api/admin/meeting', { method: 'DELETE', body: JSON.stringify({ room }) });
      toast(act === 'end' ? '会议已结束并归档' : act === 'reopen' ? '会议已重开' : '已删除');
      loadMeetings();
    } catch (e) { toast('失败：' + e.message); }
  }

  $('newMeetingBtn').addEventListener('click', async () => {
    const room = prompt('新会议房间号（留空自动生成，仅小写字母数字）：') || '';
    const title = prompt('会议标题（可选）：') || '';
    try {
      const d = await (await adminFetch('/api/admin/meeting/start', { method: 'POST', body: JSON.stringify({ room: room || undefined, title: title || undefined }) })).json();
      toast('已创建会议：' + d.room);
      window.open('/speaker?room=' + encodeURIComponent(d.room), '_blank');
      loadMeetings();
    } catch (e) { toast('失败：' + e.message); }
  });
  // ---- users ----
  async function loadUsers() {
    let d;
    try { d = await (await adminFetch('/api/admin/users')).json(); } catch { return; }
    const rows = (d.users || []).map((u) => `<tr>
      <td class="mono">${esc(u.username)}</td>
      <td><span class="st ${u.role === 'admin' ? 'live' : 'active'}">${u.role}</span></td>
      <td class="mono">${fmtTime(u.created_at)}</td>
      <td>
        <button class="actbtn" data-uact="pwd" data-user="${esc(u.username)}">改密码</button>
        <button class="actbtn danger" data-uact="del" data-user="${esc(u.username)}">删除</button>
      </td></tr>`).join('');
    $('users').innerHTML = rows || '<tr><td colspan="4" style="color:var(--faint);padding:14px">暂无用户</td></tr>';
    $('users').querySelectorAll('button[data-uact]').forEach((b) => b.addEventListener('click', () => userAction(b.getAttribute('data-uact'), b.getAttribute('data-user'))));
  }
  async function userAction(act, username) {
    try {
      if (act === 'pwd') {
        const p = prompt(`为「${username}」设置新密码：`);
        if (!p) return;
        await adminFetch('/api/admin/users/password', { method: 'POST', body: JSON.stringify({ username, password: p }) });
        toast('密码已更新');
      } else if (act === 'del') {
        if (!confirm(`删除用户「${username}」？`)) return;
        const r = await (await adminFetch('/api/admin/users', { method: 'DELETE', body: JSON.stringify({ username }) })).json();
        toast(r.ok ? '已删除' : (r.error || '失败'));
        loadUsers();
      }
    } catch (e) { toast('失败：' + e.message); }
  }
  $('addUserBtn').addEventListener('click', async () => {
    const username = $('newUser').value.trim();
    const password = $('newPass').value;
    const role = $('newRole').value;
    if (!username || !password) { $('userStatus').textContent = '用户名/密码必填'; return; }
    try {
      const r = await (await adminFetch('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, role }) })).json();
      if (r.ok) { $('userStatus').textContent = '✓ 已保存'; $('newUser').value = ''; $('newPass').value = ''; loadUsers(); }
      else $('userStatus').textContent = r.error || '失败';
    } catch (e) { $('userStatus').textContent = '失败：' + e.message; }
  });
  $('refreshUsersBtn').addEventListener('click', loadUsers);
  $('refreshSessionsBtn').addEventListener('click', loadSessions);

  $('refreshBtn').addEventListener('click', loadMeetings);
  $('loginBtn').addEventListener('click', () => login($('userInput').value.trim().toLowerCase(), $('passInput').value));
  $('passInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') login($('userInput').value.trim().toLowerCase(), $('passInput').value); });
  $('logoutBtn').addEventListener('click', () => { localStorage.removeItem('mc_auth'); token = ''; showLogin('已退出'); });

  // boot
  (async () => { if (await verifyToken()) showDash(); else showLogin(); })();
})();
