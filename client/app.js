(function () {
  const root = document.getElementById('app');

  // ---------------- App state ----------------
  let token = localStorage.getItem('dara_token') || null;
  let me = null; // {id, username, avatarColor, rating, wins, losses, aiGames}
  let activeTab = 'game';
  let authMode = 'login'; // 'login' | 'register'
  let authError = '';
  let socket = null;

  let friendsState = { friends: [], incomingRequests: [], outgoingRequests: [] };
  let selectedFriendId = null;
  let chatMessages = [];
  let friendUsernameInput = '';

  let notifications = [];
  let historyState = [];

  let groupsState = [];
  let selectedGroupId = null;
  let groupMessages = [];
  let showNewGroupForm = false;
  let newGroupName = '';
  let newGroupMemberIds = [];

  // ---------------- Game state ----------------
  const CONFIGS = { '5x5': { rows: 5, cols: 5, pieces: 10 }, '6x5': { rows: 6, cols: 5, pieces: 12 }, '6x6': { rows: 6, cols: 6, pieces: 14 } };
  let boardKey = '6x5';
  let COLS = 5, ROWS = 6, TOTAL = 30, PIECES = 12;
  let board = new Array(TOTAL).fill(0);
  let placed = [0, 0];
  let current = 1;
  let phase = 'placement';
  let selected = null;
  let captureMode = false;
  let removable = [];
  let gameOver = false;
  let message = '';
  let aiEnabled = false;

  const TIERS = [
    { name: 'Wood', min: -Infinity }, { name: 'Bronze', min: 900 }, { name: 'Silver', min: 1000 },
    { name: 'Gold', min: 1100 }, { name: 'Platinum', min: 1200 }, { name: 'Diamond', min: 1300 }, { name: 'Master', min: 1400 }
  ];

  function tierFor(rating) {
    let ix = 0;
    for (let i = 0; i < TIERS.length; i++) if (rating >= TIERS[i].min) ix = i;
    return TIERS[ix].name;
  }

  function aiEpsilon() {
    const games = (me && me.aiGames) || 0;
    return Math.max(0.05, 0.4 - games * 0.01);
  }

  // ---------------- API helper ----------------
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // ---------------- Auth ----------------
  async function submitAuth(username, password) {
    authError = '';
    try {
      const data = await api(authMode === 'login' ? '/auth/login' : '/auth/register', {
        method: 'POST', body: { username, password }
      });
      token = data.token;
      localStorage.setItem('dara_token', token);
      await loadMe();
      connectSocket();
      render();
    } catch (e) {
      authError = e.message;
      render();
    }
  }

  function logout() {
    localStorage.removeItem('dara_token');
    token = null; me = null;
    if (socket) { socket.disconnect(); socket = null; }
    render();
  }

  async function loadMe() {
    me = await api('/me');
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('new_message', (msg) => {
      if (selectedFriendId && (msg.senderId === selectedFriendId || msg.recipientId === selectedFriendId)) {
        chatMessages.push(msg);
        render();
      }
    });
    socket.on('new_group_message', (msg) => {
      if (selectedGroupId && msg.groupId === selectedGroupId) {
        groupMessages.push(msg);
        render();
      }
    });
    socket.on('new_notification', (n) => {
      notifications.unshift(n);
      render();
    });
    socket.on('message_error', (payload) => {
      alert((payload && payload.error) || 'Message could not be sent.');
    });
  }

  // ---------------- Game engine ----------------
  function applyConfig(key) {
    const c = CONFIGS[key];
    ROWS = c.rows; COLS = c.cols; TOTAL = ROWS * COLS; PIECES = c.pieces;
  }
  function idx(r, c) { return r * COLS + c; }
  function rc(i) { return [Math.floor(i / COLS), i % COLS]; }
  function neighbors(i) {
    const [r, c] = rc(i); const res = [];
    if (r > 0) res.push(i - COLS);
    if (r < ROWS - 1) res.push(i + COLS);
    if (c > 0) res.push(i - 1);
    if (c < COLS - 1) res.push(i + 1);
    return res;
  }
  function isAdjacent(a, b) { return neighbors(a).indexOf(b) !== -1; }

  function checkMillAt(arr, i, player) {
    const [row, col] = rc(i);
    let cnt = 1, c;
    c = col - 1; while (c >= 0 && arr[idx(row, c)] === player) { cnt++; c--; }
    c = col + 1; while (c < COLS && arr[idx(row, c)] === player) { cnt++; c++; }
    if (cnt >= 3) return true;
    cnt = 1; let r;
    r = row - 1; while (r >= 0 && arr[idx(r, col)] === player) { cnt++; r--; }
    r = row + 1; while (r < ROWS && arr[idx(r, col)] === player) { cnt++; r++; }
    return cnt >= 3;
  }

  function countPieces(p) { return board.filter(v => v === p).length; }
  function hasLegalMove(p) {
    for (let i = 0; i < TOTAL; i++) if (board[i] === p && neighbors(i).some(n => board[n] === 0)) return true;
    return false;
  }
  function opponentOf(p) { return p === 1 ? 2 : 1; }

  function findThreats(arr, forPlayer) {
    const threats = [];
    for (let e = 0; e < TOTAL; e++) {
      if (arr[e] === 0) {
        const t = arr.slice(); t[e] = forPlayer;
        if (checkMillAt(t, e, forPlayer) && neighbors(e).some(n => arr[n] === forPlayer)) threats.push(e);
      }
    }
    return threats;
  }

  async function reportResult(winner) {
    if (!aiEnabled) return;
    try {
      const data = await api('/game/result', { method: 'POST', body: { result: winner === 1 ? 'win' : 'loss', boardSize: boardKey } });
      if (me) { me.rating = data.rating; me.wins = data.wins; me.losses = data.losses; me.aiGames = (me.aiGames || 0) + 1; }
    } catch (e) { /* non-fatal */ }
  }

  function endGame(winner) {
    gameOver = true;
    const wname = (winner === 2 && aiEnabled) ? 'AI' : 'Player ' + winner;
    message = wname + ' wins!';
    reportResult(winner).then(render);
    render();
  }

  function afterMoveOrCapture() {
    const opp = opponentOf(current);
    if (phase === 'movement' && countPieces(opp) < 3) { endGame(current); return; }
    current = opp;
    if (phase === 'movement' && !hasLegalMove(current)) { endGame(opponentOf(current)); return; }
    message = '';
    render();
    maybeAIMove();
  }

  function attemptPlacement(i) {
    if (board[i] !== 0) return;
    const t = board.slice(); t[i] = current;
    if (checkMillAt(t, i, current)) { message = "That would line up 3 - choose a different point."; render(); return; }
    board[i] = current;
    placed[current - 1]++;
    if (placed[0] === PIECES && placed[1] === PIECES) phase = 'movement';
    afterMoveOrCapture();
  }

  function startCapture() {
    captureMode = true;
    const opp = opponentOf(current);
    const oppIdx = []; for (let i = 0; i < TOTAL; i++) if (board[i] === opp) oppIdx.push(i);
    const nonMill = oppIdx.filter(i => !checkMillAt(board, i, opp));
    removable = nonMill.length ? nonMill : oppIdx;
    message = 'Line formed - remove one of the highlighted pieces.';
    render();
  }

  function removePiece(i) {
    board[i] = 0; captureMode = false; removable = [];
    const opp = opponentOf(current);
    if (countPieces(opp) < 3) { endGame(current); return; }
    current = opp;
    if (phase === 'movement' && !hasLegalMove(current)) { endGame(opponentOf(current)); return; }
    message = '';
    render();
    maybeAIMove();
  }

  function attemptMove(from, to) {
    const t = board.slice(); t[from] = 0; t[to] = current;
    const mill = checkMillAt(t, to, current);
    board = t; selected = null;
    if (mill) { startCapture(); return; }
    afterMoveOrCapture();
  }

  function aiPlace() {
    const legal = [];
    for (let i = 0; i < TOTAL; i++) {
      if (board[i] === 0) { const t = board.slice(); t[i] = current; if (!checkMillAt(t, i, current)) legal.push(i); }
    }
    if (!legal.length) return;
    if (Math.random() < aiEpsilon()) { attemptPlacement(legal[Math.floor(Math.random() * legal.length)]); return; }
    function runScore(i) {
      const t = board.slice(); t[i] = current;
      const [row, col] = rc(i);
      let hr = 1, c; c = col - 1; while (c >= 0 && t[idx(row, c)] === current) { hr++; c--; } c = col + 1; while (c < COLS && t[idx(row, c)] === current) { hr++; c++; }
      let vr = 1, r; r = row - 1; while (r >= 0 && t[idx(r, col)] === current) { vr++; r--; } r = row + 1; while (r < ROWS && t[idx(r, col)] === current) { vr++; r++; }
      return Math.max(hr, vr);
    }
    let best = [], bestScore = -1;
    legal.forEach(i => { const s = runScore(i); if (s > bestScore) { bestScore = s; best = [i]; } else if (s === bestScore) best.push(i); });
    attemptPlacement(best[Math.floor(Math.random() * best.length)]);
  }

  function aiMove() {
    const moves = [];
    for (let i = 0; i < TOTAL; i++) if (board[i] === current) neighbors(i).forEach(n => { if (board[n] === 0) moves.push({ from: i, to: n }); });
    if (!moves.length) return;
    if (Math.random() < aiEpsilon()) { const m = moves[Math.floor(Math.random() * moves.length)]; attemptMove(m.from, m.to); return; }
    const millMoves = moves.filter(m => { const t = board.slice(); t[m.from] = 0; t[m.to] = current; return checkMillAt(t, m.to, current); });
    let chosen = null;
    if (millMoves.length) chosen = millMoves[Math.floor(Math.random() * millMoves.length)];
    else {
      const opp = opponentOf(current);
      const threats = findThreats(board, opp);
      if (threats.length) {
        const blocking = moves.filter(m => threats.indexOf(m.to) !== -1);
        if (blocking.length) chosen = blocking[Math.floor(Math.random() * blocking.length)];
      }
      if (!chosen) {
        const safe = moves.filter(m => { const t = board.slice(); t[m.from] = 0; t[m.to] = current; return findThreats(t, opp).length === 0; });
        const pool = safe.length ? safe : moves;
        chosen = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    attemptMove(chosen.from, chosen.to);
  }

  function aiCapture() {
    if (!removable.length) return;
    if (Math.random() < aiEpsilon()) { removePiece(removable[Math.floor(Math.random() * removable.length)]); return; }
    const opp = opponentOf(current);
    let best = [], bestScore = -1;
    removable.forEach(i => { const s = neighbors(i).filter(n => board[n] === opp).length; if (s > bestScore) { bestScore = s; best = [i]; } else if (s === bestScore) best.push(i); });
    removePiece(best[Math.floor(Math.random() * best.length)]);
  }

  function maybeAIMove() {
    if (gameOver || !aiEnabled || current !== 2 || activeTab !== 'game') return;
    setTimeout(() => {
      if (gameOver) return;
      if (captureMode) aiCapture();
      else if (phase === 'placement') aiPlace();
      else aiMove();
    }, 550);
  }

  function cellClick(i) {
    if (gameOver) return;
    if (aiEnabled && current === 2) return;
    if (captureMode) {
      if (removable.indexOf(i) !== -1) removePiece(i);
      else { message = 'Pick a highlighted piece to remove.'; render(); }
      return;
    }
    if (phase === 'placement') { attemptPlacement(i); return; }
    if (selected === null) {
      if (board[i] === current) {
        if (neighbors(i).some(n => board[n] === 0)) { selected = i; message = ''; render(); }
        else { message = 'That piece has no empty space to move into.'; render(); }
      } else { message = 'Select one of your own pieces.'; render(); }
      return;
    }
    if (i === selected) { selected = null; render(); return; }
    if (board[i] === current) { selected = i; render(); return; }
    if (board[i] === 0 && isAdjacent(selected, i)) { attemptMove(selected, i); return; }
    message = 'Move to an adjacent empty point.'; render();
  }

  function resetGame() {
    applyConfig(boardKey);
    board = new Array(TOTAL).fill(0); placed = [0, 0]; current = 1; phase = 'placement';
    selected = null; captureMode = false; removable = []; gameOver = false; message = '';
    render();
  }

  // ---------------- Friends & chat ----------------
  async function loadFriends() {
    friendsState = await api('/friends');
    render();
  }
  async function sendFriendRequest(username) {
    try { await api('/friends/request', { method: 'POST', body: { username } }); friendUsernameInput = ''; await loadFriends(); }
    catch (e) { alert(e.message); }
  }
  async function acceptRequest(requestId) { await api('/friends/accept', { method: 'POST', body: { requestId } }); await loadFriends(); }
  async function declineRequest(requestId) { await api('/friends/decline', { method: 'POST', body: { requestId } }); await loadFriends(); }
  async function removeFriend(friendId) { await api('/friends/' + friendId, { method: 'DELETE' }); if (selectedFriendId === friendId) selectedFriendId = null; await loadFriends(); }

  async function openChat(friendId) {
    selectedFriendId = friendId;
    chatMessages = await api('/messages/' + friendId);
    const ids = notifications.filter(n => !n.isRead && n.type === 'message' && n.data && n.data.fromUserId === friendId).map(n => n.id);
    if (ids.length) await markNotificationsRead(ids);
    render();
  }
  function sendMessage(text) {
    text = (text || '').trim();
    if (!text || !selectedFriendId || !socket) return;
    socket.emit('private_message', { toUserId: selectedFriendId, text });
  }

  // ---------------- Match history ----------------
  async function loadHistory() {
    historyState = await api('/history');
    render();
  }

  // ---------------- Notifications ----------------
  async function loadNotifications() {
    notifications = await api('/notifications');
    render();
  }
  async function markNotificationsRead(ids) {
    try { await api('/notifications/read', { method: 'POST', body: ids ? { ids } : {} }); } catch (e) { /* non-fatal */ }
    if (ids) notifications.forEach(n => { if (ids.indexOf(n.id) !== -1) n.isRead = true; });
    else notifications.forEach(n => { n.isRead = true; });
  }
  function unreadCountByType(types) {
    return notifications.filter(n => !n.isRead && types.indexOf(n.type) !== -1).length;
  }

  // ---------------- Groups ----------------
  async function loadGroups() {
    groupsState = await api('/groups');
    render();
  }
  async function createGroup() {
    const name = (newGroupName || '').trim();
    if (!name) { alert('Enter a group name'); return; }
    if (!newGroupMemberIds.length) { alert('Pick at least one friend'); return; }
    try {
      await api('/groups', { method: 'POST', body: { name, memberIds: newGroupMemberIds } });
      newGroupName = ''; newGroupMemberIds = []; showNewGroupForm = false;
      await loadGroups();
    } catch (e) { alert(e.message); }
  }
  function toggleGroupMember(id) {
    const ix = newGroupMemberIds.indexOf(id);
    if (ix === -1) newGroupMemberIds.push(id); else newGroupMemberIds.splice(ix, 1);
    render();
  }
  async function openGroup(groupId) {
    selectedGroupId = groupId;
    groupMessages = await api('/groups/' + groupId + '/messages');
    const ids = notifications.filter(n => !n.isRead && n.type === 'group_message' && n.data && n.data.groupId === groupId).map(n => n.id);
    if (ids.length) await markNotificationsRead(ids);
    render();
  }
  function sendGroupMessage(text) {
    text = (text || '').trim();
    if (!text || !selectedGroupId || !socket) return;
    socket.emit('group_message', { groupId: selectedGroupId, text });
  }

  // ---------------- Rendering ----------------
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function renderAuth() {
    root.innerHTML = `
      <div class="auth-hero">
        <h1 class="auth-wordmark">D<em>a</em>ra</h1>
        <p class="auth-tagline">a line of three, and the board is yours</p>
      </div>
      <div class="hint" style="text-align:center;margin-top:18px;">${authMode === 'login' ? 'Log in to your account' : 'Create an account'}</div>
      <div class="card">
        <div style="margin-bottom:4px;"><input id="f-username" placeholder="Username" style="width:100%;" /></div>
        <div class="hint" style="margin-bottom:10px;">3-24 characters: letters, numbers, _ or -</div>
        <div style="margin-bottom:4px;"><input id="f-password" type="password" placeholder="Password" style="width:100%;" /></div>
        <div class="hint" style="margin-bottom:10px;">8+ characters, with at least one letter and one number</div>
        ${authError ? `<div class="error-text">${esc(authError)}</div>` : ''}
        <button class="primary" id="f-submit" style="width:100%;margin-top:6px;">${authMode === 'login' ? 'Log in' : 'Register'}</button>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);text-align:center;">
        ${authMode === 'login' ? "New here?" : "Already have an account?"}
        <a href="#" id="f-switch">${authMode === 'login' ? 'Create an account' : 'Log in'}</a>
      </div>
    `;
    document.getElementById('f-submit').addEventListener('click', () => {
      submitAuth(document.getElementById('f-username').value.trim(), document.getElementById('f-password').value);
    });
    document.getElementById('f-switch').addEventListener('click', (e) => {
      e.preventDefault(); authMode = authMode === 'login' ? 'register' : 'login'; authError = ''; render();
    });
  }

  function renderGameTab() {
    const p1c = countPieces(1), p2c = countPieces(2);
    const name2 = aiEnabled ? 'AI' : 'Player 2';
    const turnLabel = gameOver ? message : ((current === 1 ? 'Player 1' : name2) + "'s turn" + (phase === 'placement' ? ' (placing)' : ''));
    const sub = gameOver ? '' : (message || (phase === 'placement' ? ((PIECES - placed[0]) + ' left for P1, ' + (PIECES - placed[1]) + ' left for ' + name2) : 'Tap a piece, then tap where to move it'));
    let h = '';
    h += `<div class="row wrap" style="margin-bottom:12px;">
      <select id="g-size">${['6x5', '5x5', '6x6'].map(k => `<option value="${k}"${k === boardKey ? ' selected' : ''}>${k} board</option>`).join('')}</select>
      <label style="font-size:13px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;"><input type="checkbox" id="g-ai"${aiEnabled ? ' checked' : ''}/> Play vs AI</label>
    </div>`;
    h += `<div class="row between" style="margin-bottom:10px;">
      <div class="row"><span style="width:12px;height:12px;border-radius:50%;background:${current === 1 ? 'var(--accent)' : 'var(--gold)'};display:inline-block;"></span><span style="font-weight:500;">${turnLabel}</span></div>
      <button id="g-reset">Reset</button>
    </div>`;
    h += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;min-height:18px;">${sub}</div>`;
    h += `<div id="g-grid" class="grid-board" style="grid-template-columns:repeat(${COLS},1fr);"></div>`;
    h += `<div class="row wrap" style="margin-top:12px;font-size:13px;color:var(--text-secondary);">
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);margin-right:6px;"></span>Player 1: ${p1c} on board</span>
      <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--gold);margin-right:6px;"></span>${name2}: ${p2c} on board</span>
    </div>`;
    if (aiEnabled && me) {
      h += `<div class="card" style="margin-top:14px;">
        <div style="font-weight:500;margin-bottom:4px;">Rank: ${tierFor(me.rating)} (${me.rating})</div>
        <div style="font-size:13px;color:var(--text-secondary);">${me.wins}W - ${me.losses}L vs AI &middot; ${me.aiGames} games played</div>
      </div>`;
    }
    return h;
  }

  function renderProfileTab() {
    const swatches = ['#B8452C', '#D6A94A', '#5B8C5A', '#7B6FC4', '#3C7A8C', '#B0507A'];
    return `
      <div class="section-title">Profile</div>
      <div class="row" style="margin-bottom:16px;">
        <div class="avatar" style="width:56px;height:56px;font-size:20px;background:${me.avatarColor};">${esc((me.username || 'P').charAt(0).toUpperCase())}</div>
        <div>
          <div style="font-weight:600;">${esc(me.username)}</div>
          <div style="font-size:13px;color:var(--text-secondary);">${tierFor(me.rating)} &middot; ${me.rating} rating</div>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">Avatar color</div>
      <div class="row" style="margin-bottom:16px;">
        ${swatches.map(c => `<button data-color="${c}" class="p-swatch" style="width:28px;height:28px;border-radius:50%;background:${c};border:${c === me.avatarColor ? '2px solid var(--text)' : '2px solid transparent'};padding:0;"></button>`).join('')}
      </div>
      <div class="card">
        <div style="font-weight:500;margin-bottom:6px;">Stats</div>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.8;">Record vs AI: ${me.wins}W - ${me.losses}L<br/>AI games played: ${me.aiGames}</div>
      </div>
      <div style="font-size:13px;font-weight:500;margin:14px 0 6px;">Recent games</div>
      ${historyState.length ? historyState.map(h => `
        <div class="list-row">
          <span>${h.result === 'win' ? 'Win' : 'Loss'} vs AI <span style="color:var(--text-muted);">(${esc(h.boardSize || '')})</span></span>
          <span style="font-size:12px;color:var(--text-secondary);">${h.ratingAfter} rating</span>
        </div>`).join('') : '<div style="font-size:13px;color:var(--text-secondary);">No games recorded yet - play a round vs AI.</div>'}
      <button id="p-logout" style="margin-top:16px;">Log out</button>
    `;
  }

  function renderFriendsTab() {
    let h = `<div class="section-title">Friends</div>`;
    h += `<div class="row" style="margin-bottom:14px;">
      <input id="fr-input" placeholder="Add by exact username" style="flex:1;" value="${esc(friendUsernameInput)}"/>
      <button id="fr-add">Add</button>
    </div>`;
    if (friendsState.incomingRequests.length) {
      h += `<div style="font-size:13px;font-weight:500;margin-bottom:6px;">Requests</div>`;
      friendsState.incomingRequests.forEach(r => {
        h += `<div class="list-row"><span>${esc(r.username)}</span>
          <span class="row">
            <button data-id="${r.requestId}" class="fr-accept">Accept</button>
            <button data-id="${r.requestId}" class="fr-decline">Decline</button>
          </span></div>`;
      });
    }
    h += `<div style="font-size:13px;font-weight:500;margin:12px 0 6px;">Your friends</div>`;
    if (!friendsState.friends.length) h += `<div style="font-size:13px;color:var(--text-secondary);">No friends yet - add one by username above.</div>`;
    friendsState.friends.forEach(f => {
      h += `<div class="list-row">
        <span class="row"><span class="avatar" style="width:26px;height:26px;font-size:12px;background:${f.avatarColor || 'var(--accent)'};">${esc(f.username.charAt(0).toUpperCase())}</span>${esc(f.username)}</span>
        <span class="row">
          <button data-id="${f.id}" class="fr-chat">Chat</button>
          <button data-id="${f.id}" class="fr-remove">Remove</button>
        </span></div>`;
    });
    return h;
  }

  function renderChatTab() {
    if (selectedFriendId) {
      const friend = friendsState.friends.find(f => f.id === selectedFriendId);
      let h = `<div class="section-title">${friend ? esc(friend.username) : 'Chat'}</div>`;
      h += `<div class="chat-log" id="c-log">`;
      if (!chatMessages.length) h += `<div style="font-size:13px;color:var(--text-muted);">No messages yet - say hello.</div>`;
      chatMessages.forEach(m => {
        const mine = m.senderId === me.id;
        h += `<div class="msg ${mine ? 'mine' : ''}"><span class="who">${mine ? 'You' : (friend ? esc(friend.username) : '')}</span>${esc(m.text)}</div>`;
      });
      h += `</div>`;
      h += `<div class="row"><input id="c-input" placeholder="Message" style="flex:1;"/><button id="c-send" class="primary">Send</button></div>`;
      h += `<button id="c-back" style="margin-top:10px;">Back</button>`;
      return h;
    }

    if (selectedGroupId) {
      const group = groupsState.find(g => g.id === selectedGroupId);
      let h = `<div class="section-title">${group ? esc(group.name) : 'Group'}</div>`;
      if (group) h += `<div class="hint">${group.members.map(m => esc(m.username)).join(', ')}</div>`;
      h += `<div class="chat-log" id="c-log">`;
      if (!groupMessages.length) h += `<div style="font-size:13px;color:var(--text-muted);">No messages yet - say hello.</div>`;
      groupMessages.forEach(m => {
        const mine = m.senderId === me.id;
        h += `<div class="msg ${mine ? 'mine' : ''}"><span class="who">${mine ? 'You' : esc(m.senderUsername)}</span>${esc(m.text)}</div>`;
      });
      h += `</div>`;
      h += `<div class="row"><input id="gc-input" placeholder="Message" style="flex:1;"/><button id="gc-send" class="primary">Send</button></div>`;
      h += `<button id="gc-back" style="margin-top:10px;">Back</button>`;
      return h;
    }

    let h = `<div class="section-title">Chat</div>`;

    if (showNewGroupForm) {
      h += `<div class="card">
        <div style="font-weight:500;margin-bottom:8px;">New group</div>
        <input id="ng-name" placeholder="Group name" style="width:100%;margin-bottom:10px;" value="${esc(newGroupName)}"/>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;">Add friends</div>`;
      if (!friendsState.friends.length) {
        h += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px;">You need at least one friend first.</div>`;
      } else {
        friendsState.friends.forEach(f => {
          const checked = newGroupMemberIds.indexOf(f.id) !== -1;
          h += `<label class="row" style="margin-bottom:6px;"><input type="checkbox" class="ng-member" data-id="${f.id}"${checked ? ' checked' : ''}/> ${esc(f.username)}</label>`;
        });
      }
      h += `<div class="row" style="margin-top:10px;">
        <button id="ng-create" class="primary">Create</button>
        <button id="ng-cancel">Cancel</button>
      </div></div>`;
    } else {
      h += `<button id="c-new-group" style="width:100%;margin-bottom:14px;">+ New group</button>`;
    }

    if (groupsState.length) {
      h += `<div style="font-size:13px;font-weight:500;margin-bottom:6px;">Groups</div>`;
      groupsState.forEach(g => {
        h += `<div class="list-row"><span>${esc(g.name)}</span><button data-id="${g.id}" class="c-open-group">Open</button></div>`;
      });
    }

    h += `<div style="font-size:13px;font-weight:500;margin:14px 0 6px;">Direct messages</div>`;
    if (!friendsState.friends.length) {
      h += `<div style="font-size:13px;color:var(--text-secondary);">Add a friend first from the Friends tab.</div>`;
    } else {
      friendsState.friends.forEach(f => {
        h += `<div class="list-row"><span>${esc(f.username)}</span><button data-id="${f.id}" class="c-open-direct">Open</button></div>`;
      });
    }
    return h;
  }

  function renderNav() {
    const tabs = [{ k: 'game', l: 'Game' }, { k: 'profile', l: 'Profile' }, { k: 'friends', l: 'Friends' }, { k: 'chat', l: 'Chat' }];
    const friendsBadge = friendsState.incomingRequests.length;
    const chatBadge = unreadCountByType(['message', 'group_message']);
    const badgeFor = (k) => {
      const n = k === 'friends' ? friendsBadge : (k === 'chat' ? chatBadge : 0);
      return n > 0 ? `<span style="position:absolute;top:-2px;right:-8px;background:var(--camwood);color:#fff;font-size:10px;border-radius:8px;padding:1px 5px;min-width:14px;text-align:center;">${n > 9 ? '9+' : n}</span>` : '';
    };
    return `<div class="nav">${tabs.map(t => `<button data-tab="${t.k}" class="nav-btn${activeTab === t.k ? ' active' : ''}" style="position:relative;">${t.l}${badgeFor(t.k)}</button>`).join('')}</div>`;
  }

  function render() {
    if (!token || !me) { renderAuth(); return; }
    let html = '';
    if (activeTab === 'game') html = renderGameTab();
    else if (activeTab === 'profile') html = renderProfileTab();
    else if (activeTab === 'friends') html = renderFriendsTab();
    else if (activeTab === 'chat') html = renderChatTab();
    html += renderNav();
    root.innerHTML = html;

    if (activeTab === 'game') {
      const grid = document.getElementById('g-grid');
      for (let i = 0; i < TOTAL; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        if (i === selected) cell.style.background = 'var(--accent-bg)';
        if (captureMode && removable.indexOf(i) !== -1) cell.style.background = 'var(--danger-bg)';
        if (!captureMode && phase === 'movement' && selected !== null && board[i] === 0 && isAdjacent(selected, i)) cell.style.background = 'var(--success-bg)';
        if (board[i] !== 0) {
          const piece = document.createElement('div');
          piece.className = 'piece';
          piece.style.background = board[i] === 1 ? 'var(--accent)' : 'var(--gold)';
          cell.appendChild(piece);
        }
        cell.addEventListener('click', () => cellClick(i));
        grid.appendChild(cell);
      }
      document.getElementById('g-reset').addEventListener('click', resetGame);
      document.getElementById('g-size').addEventListener('change', (e) => { boardKey = e.target.value; resetGame(); });
      document.getElementById('g-ai').addEventListener('change', (e) => { aiEnabled = e.target.checked; resetGame(); });
      maybeAIMove();
    }

    if (activeTab === 'profile') {
      document.querySelectorAll('.p-swatch').forEach(btn => btn.addEventListener('click', async () => {
        me.avatarColor = btn.getAttribute('data-color');
        await api('/me', { method: 'PATCH', body: { avatarColor: me.avatarColor } });
        render();
      }));
      document.getElementById('p-logout').addEventListener('click', logout);
    }
    if (activeTab === 'friends') {
      document.getElementById('fr-add').addEventListener('click', () => {
        const v = document.getElementById('fr-input').value.trim();
        if (v) sendFriendRequest(v);
      });
      document.querySelectorAll('.fr-accept').forEach(b => b.addEventListener('click', () => acceptRequest(parseInt(b.getAttribute('data-id'), 10))));
      document.querySelectorAll('.fr-decline').forEach(b => b.addEventListener('click', () => declineRequest(parseInt(b.getAttribute('data-id'), 10))));
      document.querySelectorAll('.fr-remove').forEach(b => b.addEventListener('click', () => removeFriend(parseInt(b.getAttribute('data-id'), 10))));
      document.querySelectorAll('.fr-chat').forEach(b => b.addEventListener('click', () => { activeTab = 'chat'; openChat(parseInt(b.getAttribute('data-id'), 10)); }));
    }

    if (activeTab === 'chat') {
      const sendBtn = document.getElementById('c-send');
      if (sendBtn) sendBtn.addEventListener('click', () => {
        const inp = document.getElementById('c-input');
        sendMessage(inp.value);
        inp.value = '';
      });
      const inputEl = document.getElementById('c-input');
      if (inputEl) inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { sendMessage(inputEl.value); inputEl.value = ''; } });
      const backBtn = document.getElementById('c-back');
      if (backBtn) backBtn.addEventListener('click', () => { selectedFriendId = null; render(); });

      const gcSendBtn = document.getElementById('gc-send');
      if (gcSendBtn) gcSendBtn.addEventListener('click', () => {
        const inp = document.getElementById('gc-input');
        sendGroupMessage(inp.value);
        inp.value = '';
      });
      const gcInputEl = document.getElementById('gc-input');
      if (gcInputEl) gcInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { sendGroupMessage(gcInputEl.value); gcInputEl.value = ''; } });
      const gcBackBtn = document.getElementById('gc-back');
      if (gcBackBtn) gcBackBtn.addEventListener('click', () => { selectedGroupId = null; render(); });

      document.querySelectorAll('.c-open-direct').forEach(b => b.addEventListener('click', () => openChat(parseInt(b.getAttribute('data-id'), 10))));
      document.querySelectorAll('.c-open-group').forEach(b => b.addEventListener('click', () => openGroup(parseInt(b.getAttribute('data-id'), 10))));

      const newGroupBtn = document.getElementById('c-new-group');
      if (newGroupBtn) newGroupBtn.addEventListener('click', () => { showNewGroupForm = true; render(); });
      const ngCancel = document.getElementById('ng-cancel');
      if (ngCancel) ngCancel.addEventListener('click', () => { showNewGroupForm = false; newGroupName = ''; newGroupMemberIds = []; render(); });
      const ngNameInput = document.getElementById('ng-name');
      if (ngNameInput) ngNameInput.addEventListener('input', (e) => { newGroupName = e.target.value; });
      document.querySelectorAll('.ng-member').forEach(cb => cb.addEventListener('change', () => toggleGroupMember(parseInt(cb.getAttribute('data-id'), 10))));
      const ngCreate = document.getElementById('ng-create');
      if (ngCreate) ngCreate.addEventListener('click', createGroup);

      const log = document.getElementById('c-log');
      if (log) log.scrollTop = log.scrollHeight;
    }

    document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => {
      activeTab = btn.getAttribute('data-tab');
      if (activeTab === 'friends') {
        loadFriends();
        const ids = notifications.filter(n => !n.isRead && (n.type === 'friend_request' || n.type === 'friend_accept')).map(n => n.id);
        if (ids.length) markNotificationsRead(ids);
      }
      if (activeTab === 'chat') { loadGroups(); selectedFriendId = null; selectedGroupId = null; }
      if (activeTab === 'profile') loadHistory();
      render();
    }));
  }

  // ---------------- Boot ----------------
  async function boot() {
    applyConfig(boardKey);
    if (token) {
      try {
        await loadMe();
        connectSocket();
        await loadFriends();
        await loadNotifications();
        await loadGroups();
      } catch (e) {
        token = null; me = null; localStorage.removeItem('dara_token');
      }
    }
    render();
  }

  boot();
})();
