import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch,
  collection, getDocs, addDoc, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Must match the UID hardcoded in firestore.rules' isAdmin(). This stops the
// dashboard from showing (and then failing on every read/write) if a voter
// account happens to be signed in on this browser from testing the voting page.
const ADMIN_UID = "UwMBW1jsOJVdGdyJOgJLDyHGK6t1";

const loginBox = document.getElementById('login-box');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('email').value.trim();
  const pass = document.getElementById('password').value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    loginError.textContent = 'Login failed — check email/password.';
  }
});

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));
document.getElementById('full-reset-btn').addEventListener('click', fullReset);

onAuthStateChanged(auth, (user) => {
  if (user && user.uid === ADMIN_UID) {
    loginBox.style.display = 'none';
    dashboard.style.display = 'block';
    initDashboard();
  } else if (user) {
    // Signed in, but not as the admin (e.g. a voter account from the
    // public voting page) — sign out and show the login form instead of a
    // dashboard that would just fail on every request.
    loginBox.style.display = 'block';
    dashboard.style.display = 'none';
    loginError.textContent = 'That sign-in isn\'t the admin account — log out and use your admin email/password.';
    signOut(auth);
  } else {
    loginBox.style.display = 'block';
    dashboard.style.display = 'none';
  }
});

async function getTournamentConfig() {
  const snap = await getDoc(doc(db, 'config', 'tournament'));
  if (!snap.exists()) {
    const initial = { phase: 'submissions', title: 'Suggestion Tournament', currentRound: 0 };
    await setDoc(doc(db, 'config', 'tournament'), initial);
    return initial;
  }
  return snap.data();
}

async function initDashboard() {
  await refreshAll();
}

async function refreshAll() {
  const cfg = await getTournamentConfig();
  document.getElementById('title-input').value = cfg.title || '';
  document.getElementById('current-phase').textContent = cfg.phase;
  renderPhaseControls(cfg);
  await renderSuggestions();
  await renderVoters();
  if (cfg.phase === 'voting' || cfg.phase === 'complete') {
    document.getElementById('bracket-admin-section').style.display = 'block';
    try {
      await renderBracketAdmin(cfg);
    } catch (err) {
      document.getElementById('bracket-admin-list').innerHTML = `
        <p class="status-msg error">The bracket data looks broken or out of date (often from an older version of this site). It can't be safely displayed or advanced.</p>
        <button id="clear-broken-bracket-btn">Clear broken bracket data</button>
      `;
      document.getElementById('bracket-next-round-wrap').innerHTML = '';
      document.getElementById('clear-broken-bracket-btn').addEventListener('click', async () => {
        await deleteDoc(doc(db, 'config', 'bracket'));
        await updateDoc(doc(db, 'config', 'tournament'), { phase: 'locked' });
        refreshAll();
      });
    }
  } else {
    document.getElementById('bracket-admin-section').style.display = 'none';
  }
}

document.getElementById('save-title-btn').addEventListener('click', async () => {
  const title = document.getElementById('title-input').value.trim();
  await updateDoc(doc(db, 'config', 'tournament'), { title });
  flash('title-status', 'Saved.');
});

function renderPhaseControls(cfg) {
  const el = document.getElementById('phase-controls');
  el.innerHTML = '';
  if (cfg.phase === 'submissions') {
    el.innerHTML = `<button id="lock-btn">Lock submissions</button>`;
    document.getElementById('lock-btn').addEventListener('click', async () => {
      await updateDoc(doc(db, 'config', 'tournament'), { phase: 'locked' });
      refreshAll();
    });
  } else if (cfg.phase === 'locked') {
    el.innerHTML = `
      <button id="reopen-btn" class="secondary">Reopen submissions</button>
      <button id="generate-btn">Generate bracket from approved suggestions</button>
    `;
    document.getElementById('reopen-btn').addEventListener('click', async () => {
      await updateDoc(doc(db, 'config', 'tournament'), { phase: 'submissions' });
      refreshAll();
    });
    document.getElementById('generate-btn').addEventListener('click', generateBracket);
  } else if (cfg.phase === 'voting') {
    el.innerHTML = `<p class="subtext">Bracket in progress — manage rounds below.</p>`;
  } else if (cfg.phase === 'complete') {
    el.innerHTML = `
      <p class="subtext">Tournament complete.</p>
      <button id="reset-btn" class="secondary">Clear bracket, keep suggestions</button>
    `;
    document.getElementById('reset-btn').addEventListener('click', softReset);
  }
}

async function renderSuggestions() {
  const snap = await getDocs(collection(db, 'suggestions'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pending = all.filter(s => s.status === 'pending');
  const approved = all.filter(s => s.status === 'approved');
  const rejected = all.filter(s => s.status === 'rejected');

  const list = document.getElementById('suggestions-list');
  list.innerHTML = `
    <button id="seed-btn" class="secondary" style="margin-bottom:1.25rem;">Add 16 random sample suggestions</button>
    <h3>Pending (${pending.length})</h3>
    ${pending.map(s => suggRow(s, ['approve', 'reject'])).join('') || '<p class="subtext">None.</p>'}
    <h3 style="margin-top:1.5rem;">Approved (${approved.length})</h3>
    ${approved.map(s => suggRow(s, ['reject'])).join('') || '<p class="subtext">None yet.</p>'}
    <h3 style="margin-top:1.5rem;">Rejected (${rejected.length})</h3>
    ${rejected.map(s => suggRow(s, ['approve'])).join('') || '<p class="subtext">None.</p>'}
  `;

  document.getElementById('seed-btn').addEventListener('click', seedSampleSuggestions);

  list.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', async () => {
    await updateDoc(doc(db, 'suggestions', btn.dataset.approve), { status: 'approved' });
    refreshAll();
  }));
  list.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', async () => {
    await updateDoc(doc(db, 'suggestions', btn.dataset.reject), { status: 'rejected' });
    refreshAll();
  }));
}

function suggRow(s, actions) {
  const btns = actions.map(a => {
    if (a === 'approve') return `<button data-approve="${s.id}">Approve</button>`;
    if (a === 'reject') return `<button class="reject" data-reject="${s.id}">Reject</button>`;
  }).join('');
  return `<div class="sugg-row">
    <span>${escapeHtml(s.text)} ${s.submitter ? `<span class="submitter">— ${escapeHtml(s.submitter)}</span>` : ''}</span>
    <span class="actions">${btns}</span>
  </div>`;
}

async function renderVoters() {
  const snap = await getDocs(collection(db, 'voters'));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pending = all.filter(v => v.status === 'pending');
  const approved = all.filter(v => v.status === 'approved');
  const rejected = all.filter(v => v.status === 'rejected');

  const list = document.getElementById('voters-list');
  list.innerHTML = `
    <h3>Pending (${pending.length})</h3>
    ${pending.map(v => voterRow(v, ['approve', 'reject'])).join('') || '<p class="subtext">None.</p>'}
    <h3 style="margin-top:1.5rem;">Approved (${approved.length})</h3>
    ${approved.map(v => voterRow(v, ['reject'])).join('') || '<p class="subtext">None yet.</p>'}
    <h3 style="margin-top:1.5rem;">Rejected (${rejected.length})</h3>
    ${rejected.map(v => voterRow(v, ['approve'])).join('') || '<p class="subtext">None.</p>'}
  `;

  list.querySelectorAll('[data-v-approve]').forEach(btn => btn.addEventListener('click', async () => {
    await updateDoc(doc(db, 'voters', btn.dataset.vApprove), { status: 'approved' });
    refreshAll();
  }));
  list.querySelectorAll('[data-v-reject]').forEach(btn => btn.addEventListener('click', async () => {
    await updateDoc(doc(db, 'voters', btn.dataset.vReject), { status: 'rejected' });
    refreshAll();
  }));
}

function voterRow(v, actions) {
  const btns = actions.map(a => {
    if (a === 'approve') return `<button data-v-approve="${v.id}">Approve</button>`;
    if (a === 'reject') return `<button class="reject" data-v-reject="${v.id}">Reject</button>`;
  }).join('');
  return `<div class="sugg-row">
    <span>${escapeHtml(v.name)}</span>
    <span class="actions">${btns}</span>
  </div>`;
}

const SAMPLE_ACTIVITIES = [
  'Bowling night', 'Trivia night', 'Escape room', 'Board game night', 'Karaoke',
  'Mini golf', 'Movie night', 'Potluck dinner', 'Hiking trip', 'Beach day',
  'BBQ cookout', 'Paintball', 'Go-karting', 'Laser tag', 'Pottery class',
  'Cooking class', 'Wine tasting', 'Axe throwing', 'Arcade night', 'Picnic in the park',
  'Camping trip', 'Bike ride', 'Museum visit', 'Comedy club', 'Pub crawl',
  'Bonfire night', 'Scavenger hunt', 'Roller skating', 'Farmers market trip', 'Kayaking'
];

async function seedSampleSuggestions() {
  const shuffled = [...SAMPLE_ACTIVITIES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picks = shuffled.slice(0, 16);

  if (!confirm(`Add these 16 random sample suggestions, pre-approved? You can still reject any of them afterward.`)) return;
  const btn = document.getElementById('seed-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    await Promise.all(picks.map(text => addDoc(collection(db, 'suggestions'), {
      text, submitter: '', status: 'approved', createdAt: serverTimestamp()
    })));
  } catch (err) {
    alert('Something went wrong adding the samples — try again.');
  }
  refreshAll();
}

// ---- Two-sided bracket ----
// Entries are padded to a power of two, split into a left half and a right
// half, and each half runs its own single-elimination mini-bracket. Once
// both halves are down to one finalist each, a Final match combines them.

async function generateBracket() {
  const snap = await getDocs(query(collection(db, 'suggestions'), where('status', '==', 'approved')));
  let entries = snap.docs.map(d => ({ id: d.id, text: d.data().text }));
  if (entries.length < 4) {
    alert('Approve at least 4 suggestions before generating a two-sided bracket.');
    return;
  }
  // pad to next power of two with byes, THEN shuffle everything together —
  // shuffling before padding left all the byes clustered at the end, which
  // meant one whole side could end up mostly byes after the split.
  let size = 1;
  while (size < entries.length) size *= 2;
  while (entries.length < size) entries.push({ id: 'bye', text: 'Bye' });

  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  const half = size / 2;
  const leftEntries = entries.slice(0, half);
  const rightEntries = entries.slice(half);

  const leftRound0 = buildRound(leftEntries, 'L', 0);
  const rightRound0 = buildRound(rightEntries, 'R', 0);

  await setDoc(doc(db, 'config', 'bracket'), {
    left: { rounds: [{ matches: leftRound0 }] },
    right: { rounds: [{ matches: rightRound0 }] },
    currentRound: 0,
    final: null
  });
  await updateDoc(doc(db, 'config', 'tournament'), { phase: 'voting', currentRound: 0 });
  refreshAll();
}

function buildRound(entries, sidePrefix, roundIndex) {
  const round = [];
  for (let i = 0; i < entries.length; i += 2) {
    const a = entries[i], b = entries[i + 1];
    const match = {
      id: `${sidePrefix}r${roundIndex}m${i / 2}`,
      aId: a.id, aText: a.text,
      bId: b.id, bText: b.text,
      winnerId: null
    };
    if (a.id === 'bye') match.winnerId = b.id;
    if (b.id === 'bye') match.winnerId = a.id;
    round.push(match);
  }
  return round;
}

async function renderBracketAdmin(cfg) {
  const snap = await getDoc(doc(db, 'config', 'bracket'));
  if (!snap.exists()) return;
  const bracket = snap.data();
  const container = document.getElementById('bracket-admin-list');
  const nextBtnWrap = document.getElementById('bracket-next-round-wrap');
  container.innerHTML = '';
  nextBtnWrap.innerHTML = '';

  if (bracket.final) {
    container.innerHTML = `<h3>Final</h3>`;
    container.appendChild(await matchRow(bracket.final, 'final', -1));
    container.querySelectorAll('[data-declare]').forEach(btn => btn.addEventListener('click', async () => {
      await declareFinalWinner(bracket, btn.dataset.declare, btn.dataset.winner);
    }));
    if (bracket.final.winnerId) {
      nextBtnWrap.innerHTML = `<button id="finish-btn">Finish tournament</button>`;
      document.getElementById('finish-btn').addEventListener('click', async () => {
        await updateDoc(doc(db, 'config', 'tournament'), { phase: 'complete' });
        refreshAll();
      });
    }
    return;
  }

  const roundIdx = bracket.currentRound;
  const leftMatches = bracket.left.rounds[roundIdx].matches;
  const rightMatches = bracket.right.rounds[roundIdx].matches;
  const totalRounds = bracket.left.rounds[0].matches.length > 0 ? Math.log2(bracket.left.rounds[0].matches.length * 2) : 1;

  container.innerHTML = `<h3>Round ${roundIdx + 1} of ${totalRounds} (per side)</h3><h4 style="margin-top:1rem;">Left side</h4>`;
  for (const m of leftMatches) container.appendChild(await matchRow(m, 'left', roundIdx));
  container.insertAdjacentHTML('beforeend', '<h4 style="margin-top:1.25rem;">Right side</h4>');
  for (const m of rightMatches) container.appendChild(await matchRow(m, 'right', roundIdx));

  container.querySelectorAll('[data-declare]').forEach(btn => btn.addEventListener('click', async () => {
    await declareWinner(bracket, btn.dataset.side, roundIdx, btn.dataset.declare, btn.dataset.winner);
  }));

  const allDecided = leftMatches.every(m => m.winnerId) && rightMatches.every(m => m.winnerId);
  if (allDecided) {
    if (leftMatches.length === 1) {
      nextBtnWrap.innerHTML = `<button id="final-btn">Both finalists decided — create the Final match</button>`;
      document.getElementById('final-btn').addEventListener('click', () => generateFinal(bracket, roundIdx));
    } else {
      nextBtnWrap.innerHTML = `<button id="next-round-btn">Generate next round (both sides)</button>`;
      document.getElementById('next-round-btn').addEventListener('click', () => generateNextRound(bracket, roundIdx));
    }
  }
}

async function matchRow(m, side, roundIdx) {
  const rowEl = document.createElement('div');
  rowEl.className = 'sugg-row';
  rowEl.style.flexDirection = 'column';
  rowEl.style.alignItems = 'stretch';

  if (m.aId === 'bye' || m.bId === 'bye') {
    rowEl.innerHTML = `<strong>${escapeHtml(m.winnerId === m.aId ? m.aText : m.bText)}</strong> — auto-advanced (bye)`;
    return rowEl;
  }

  const counts = await getVoteCounts(m.id);
  rowEl.innerHTML = `
    <div style="display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
      <span>${escapeHtml(m.aText)} (${counts[m.aId] || 0} votes) vs ${escapeHtml(m.bText)} (${counts[m.bId] || 0} votes)</span>
      <span class="actions">
        ${m.winnerId
          ? `<strong>Winner: ${escapeHtml(m.winnerId === m.aId ? m.aText : m.bText)}</strong>`
          : `<button data-declare="${m.id}" data-side="${side}" data-winner="${m.aId}">${escapeHtml(m.aText)} wins</button>
             <button data-declare="${m.id}" data-side="${side}" data-winner="${m.bId}">${escapeHtml(m.bText)} wins</button>`
        }
      </span>
    </div>
  `;
  return rowEl;
}

async function getVoteCounts(matchId) {
  const snap = await getDocs(query(collection(db, 'votes'), where('matchId', '==', matchId)));
  const counts = {};
  snap.docs.forEach(d => {
    const c = d.data().choice;
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

async function declareWinner(bracket, side, roundIdx, matchId, winnerId) {
  const sideData = side === 'left' ? bracket.left : bracket.right;
  const match = sideData.rounds[roundIdx].matches.find(m => m.id === matchId);
  match.winnerId = winnerId;
  await updateDoc(doc(db, 'config', 'bracket'), { [side]: sideData });
  refreshAll();
}

async function declareFinalWinner(bracket, matchId, winnerId) {
  const final = { ...bracket.final, winnerId };
  await updateDoc(doc(db, 'config', 'bracket'), { final });
  refreshAll();
}

async function generateNextRound(bracket, roundIdx) {
  const nextLeft = advanceSide(bracket.left, roundIdx);
  const nextRight = advanceSide(bracket.right, roundIdx);
  await updateDoc(doc(db, 'config', 'bracket'), {
    left: nextLeft, right: nextRight, currentRound: roundIdx + 1
  });
  await updateDoc(doc(db, 'config', 'tournament'), { currentRound: roundIdx + 1 });
  refreshAll();
}

function advanceSide(sideData, roundIdx) {
  const sidePrefix = sideData.rounds[roundIdx].matches[0].id.startsWith('L') ? 'L' : 'R';
  const currentMatches = sideData.rounds[roundIdx].matches;
  const winners = currentMatches.map(m => ({
    id: m.winnerId,
    text: m.winnerId === m.aId ? m.aText : m.bText
  }));
  const nextRound = buildRound(winners, sidePrefix, roundIdx + 1);
  return { rounds: [...sideData.rounds, { matches: nextRound }] };
}

async function generateFinal(bracket, roundIdx) {
  const leftFinal = bracket.left.rounds[roundIdx].matches[0];
  const rightFinal = bracket.right.rounds[roundIdx].matches[0];
  const leftWinnerId = leftFinal.winnerId;
  const rightWinnerId = rightFinal.winnerId;
  const final = {
    id: 'final',
    aId: leftWinnerId,
    aText: leftWinnerId === leftFinal.aId ? leftFinal.aText : leftFinal.bText,
    bId: rightWinnerId,
    bText: rightWinnerId === rightFinal.aId ? rightFinal.aText : rightFinal.bText,
    winnerId: null
  };
  await updateDoc(doc(db, 'config', 'bracket'), { final });
  refreshAll();
}

async function softReset() {
  if (!confirm('This clears the bracket and reopens submissions. Suggestions are kept. Continue?')) return;
  await deleteDoc(doc(db, 'config', 'bracket'));
  await updateDoc(doc(db, 'config', 'tournament'), { phase: 'submissions', currentRound: 0 });
  refreshAll();
}

async function fullReset() {
  if (!confirm('This permanently deletes every suggestion, every vote, and the bracket, and reopens submissions from scratch. This cannot be undone. Continue?')) return;
  if (!confirm('Really sure? This cannot be undone.')) return;

  const btn = document.getElementById('full-reset-btn');
  btn.disabled = true;
  btn.textContent = 'Resetting…';

  try {
    const [suggSnap, voteSnap] = await Promise.all([
      getDocs(collection(db, 'suggestions')),
      getDocs(collection(db, 'votes'))
    ]);
    const refs = [
      ...suggSnap.docs.map(d => doc(db, 'suggestions', d.id)),
      ...voteSnap.docs.map(d => doc(db, 'votes', d.id))
    ];
    // Firestore batches are capped at 500 writes, so chunk it.
    for (let i = 0; i < refs.length; i += 450) {
      const batch = writeBatch(db);
      refs.slice(i, i + 450).forEach(ref => batch.delete(ref));
      await batch.commit();
    }
    await deleteDoc(doc(db, 'config', 'bracket')).catch(() => {});
    await setDoc(doc(db, 'config', 'tournament'), {
      phase: 'submissions', currentRound: 0, title: document.getElementById('title-input').value.trim() || 'Suggestion Tournament'
    });
  } catch (err) {
    alert(`Something went wrong during reset: ${err.code || ''} ${err.message || err}. Check the console for more detail and try again.`);
    console.error('fullReset failed:', err);
  }

  btn.disabled = false;
  btn.textContent = 'Reset everything and start over';
  refreshAll();
}

function flash(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2000);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
