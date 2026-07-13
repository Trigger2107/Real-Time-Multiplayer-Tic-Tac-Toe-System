// /static/main.js

document.addEventListener('DOMContentLoaded', () => {
  // state
  let socket = null;
  let username = '';
  let currentRoom = null;
  let mySymbol = null;
  let myTurn = false;
  let isGameOver = false;

  // helper

  function showBanner(message, type='info', duration=4000) {
    const banner = document.getElementById('gameResultBanner');
    banner.textContent = message;
    banner.className = `banner ${type}`;
    setTimeout(() => banner.className = 'banner hidden', duration);
  }

  function highlightWinningCells(indices) {
    if (!Array.isArray(indices)) return;
    indices.forEach(i => boardCells[i].classList.add('highlight'));
  }

  function addMatchHistory(resultType, opponent) {
    const history = document.getElementById('matchHistory');
    if (!history) return;

    const li = document.createElement('li');
    const statusSpan = document.createElement('span');
    statusSpan.classList.add('status');

    let resultText = '';
    if (resultType === 'win') {
      resultText = 'WON';
      statusSpan.classList.add('status-win');
    } else if (resultType === 'loss') {
      resultText = 'LOST';
      statusSpan.classList.add('status-loss');
    } else if (resultType === 'draw') {
      resultText = 'DRAW';
      statusSpan.classList.add('status-draw');
    }

    const opponentText = opponent ? `vs ${opponent}` : '';
    li.innerHTML = `<span>${opponentText}</span>`;
    statusSpan.textContent = resultText;
    li.appendChild(statusSpan);

    history.prepend(li);

    // Keep last 10 matches
    if (history.children.length > 10) history.removeChild(history.lastChild);
  }



  // DOM
  const authDiv = document.getElementById('auth');
  const lobbyDiv = document.getElementById('lobby');
  const gameAreaDiv = document.getElementById('gameArea');
  const joinBtn = document.getElementById('joinBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const playBtn = document.getElementById('playBtn');
  const usernameInput = document.getElementById('username');
  const joinStatus = document.getElementById('joinStatus');
  const queueList = document.getElementById('queueList');
  const leaderboardTableBody = document.querySelector('#leaderboardTable tbody');
  const opponentNameSpan = document.getElementById('opponentName');
  const statusBox = document.getElementById('game-status');
  const statusText = document.getElementById('status-text');
  const turnInfo = document.getElementById('turnInfo');
  const boardCells = Array.from(document.querySelectorAll('.cell'));
  const playAgainPrompt = document.getElementById('playAgainPrompt');
  const playAgainYesBtn = document.getElementById('playAgainYes');
  const playAgainNoBtn = document.getElementById('playAgainNo');

  // UI helper
  function setUIState(state) {
    authDiv.style.display = 'none';
    lobbyDiv.style.display = 'none';
    gameAreaDiv.style.display = 'none';

    if (state === 'auth') {
      authDiv.style.display = 'block';
      logoutBtn.style.display = 'none';
      joinBtn.style.display = 'inline-block';
      usernameInput.disabled = false;
    } else if (state === 'lobby') {
      lobbyDiv.style.display = 'block';
      logoutBtn.style.display = 'inline-block';
      joinBtn.style.display = 'none';
    } else if (state === 'game') {
      gameAreaDiv.style.display = 'block';
    }
  }

  function setStatus(text, cls = 'info') {
    statusText.textContent = text;
    statusBox.classList.remove('info', 'win', 'lose', 'draw');
    statusBox.classList.add(cls);
  }

  function resetGameUI() {
    currentRoom = null;
    mySymbol = null;
    myTurn = false;
    isGameOver = false;
    opponentNameSpan.textContent = '';
    turnInfo.textContent = '';
    playAgainPrompt.style.display = 'none';
    setStatus('Waiting for opponent...', 'info');
    boardCells.forEach(c => {
      c.textContent = '';
      c.classList.remove('disabled', 'highlight');
    });
  }

  function renderBoard(board) {
    if (!Array.isArray(board)) return;
    boardCells.forEach((cell, i) => {
      cell.textContent = board[i] || '';
      if (board[i]) cell.classList.add('disabled');
      else cell.classList.remove('disabled');
    });
  }

  function enableBoard(enabled) {
    boardCells.forEach(c => {
      if (enabled && !isGameOver && !c.textContent) c.classList.remove('disabled');
      else c.classList.add('disabled');
    });
  }

  function updateTurnUI(turnUsername) {
    if (!currentRoom) return;
    myTurn = (turnUsername === username);
    if (isGameOver) {
      turnInfo.textContent = '';
      enableBoard(false);
      return;
    }
    if (myTurn) {
      turnInfo.textContent = `Your turn (${mySymbol})`;
      setStatus('Your turn — make a move', 'info');
      enableBoard(true);
    } else {
      turnInfo.textContent = `Opponent's turn`;
      setStatus("Opponent is thinking...", 'info');
      enableBoard(false);
    }
  }

  // Socket
  function ensureSocket() {
    if (socket && socket.connected) return socket;
    socket = io();

    socket.on('connect_error', (err) => {
      joinStatus.textContent = `Connection error: ${err?.message || err}`;
      setUIState('auth');
    });

    socket.on('join_response', (data) => {
      if (data && data.success) {
        username = data.username;
        usernameInput.value = username;
        usernameInput.disabled = true;
        joinStatus.textContent = `Joined as ${username}`;
        setUIState('lobby');
      } else {
        joinStatus.textContent = `Join failed: ${data?.error || 'unknown'}`;
        setUIState('auth');
      }
    });

    socket.on('logged_out', () => {
      // confirm logout
      username = '';
      currentRoom = null;
      if (socket) socket.disconnect();
      setUIState('auth');
      joinStatus.textContent = 'Logged out';
      playBtn.disabled = false;
    });

    socket.on('lobby_update', (data) => {
      // update queue
      const q = Array.isArray(data.queue) ? data.queue : [];
      queueList.innerHTML = q.map((p, idx) => `<li>${p}${p === username ? ' (You)' : ''}${p === username ? ` — position ${q.indexOf(username)+1}` : ''}</li>`).join('') || '<li>(no players waiting)</li>';

      // leaderboard updated
      leaderboardTableBody.innerHTML = '';
      const lbObj = data.leaderboard || {};
      const entries = Object.entries(lbObj).sort(([,a],[,b]) => (b.wins - a.wins) || (b.games_played - a.games_played));
      entries.forEach(([player, stats]) => {
        const row = leaderboardTableBody.insertRow();
        row.insertCell().textContent = player;
        row.insertCell().textContent = stats.games_played ?? stats.games ?? 0;
        row.insertCell().textContent = stats.wins ?? 0;
        row.insertCell().textContent = stats.losses ?? 0;
        row.insertCell().textContent = stats.draws ?? 0;
      });

      // update lobby message & play button disabled status
      if (username && q.includes(username)) {
        const pos = q.indexOf(username) + 1;
        document.getElementById('lobbyMsg').textContent = `You're in the queue (position ${pos}).`;
        playBtn.disabled = true;
      } else {
        document.getElementById('lobbyMsg').textContent = 'Click "Play Game" to enter matchmaking.';
        playBtn.disabled = false;
      }
    });

    socket.on('start_game', (data) => {
  
      resetGameUI();
      currentRoom = data.room;
      mySymbol = data.your_symbol;
      opponentNameSpan.textContent = data.opponent || 'Opponent';
      setUIState('game');
      updateTurnUI(data.first_turn);
    });

    socket.on('board_update', (data) => {
      if (data && Array.isArray(data.board)) {
        renderBoard(data.board);
      }
    });

    socket.on('turn_update', (data) => {
      if (!data) return;
      const turnUser = data.turn;
      updateTurnUI(turnUser);
    });

    socket.on('game_over', (data) => {
      isGameOver = true;
      enableBoard(false);

      boardCells.forEach(c => c.classList.remove('highlight'));
      if (data.win_indices) highlightWinningCells(data.win_indices);

      if (data.result === 'win') {
        if (data.winner === username) {
          showBanner(' YOU WON THE MATCH!', 'win');
          setStatus(' You won!', 'win');
          addMatchHistory('win', opponentNameSpan.textContent);
        } else {
          showBanner(` ${data.winner} WON THE MATCH!`, 'lose');
          setStatus(` ${data.winner} won.`, 'lose');
          addMatchHistory('loss', data.winner);
        }
      } else if (data.result === 'draw') {
        showBanner(' IT’S A DRAW!', 'draw');
        setStatus(" It's a draw.", 'draw');
        addMatchHistory('draw', opponentNameSpan.textContent);
      }



      const banner = document.getElementById('gameResultBanner');
      banner.className = 'banner hidden'; // reset
      banner.textContent = '';

      if (data.result === 'win') {
        banner.className = data.winner === username ? 'banner win' : 'banner lose';
        banner.textContent = data.winner === username ? ' YOU WON THE MATCH!' : ` ${data.winner} WON THE MATCH!`;
      } else if (data.result === 'draw') {
        banner.className = 'banner draw';
        banner.textContent = ' IT’S A DRAW!';
      }
      setTimeout(() => banner.className = 'banner hidden', 6000);

      // If server includes board, render it
      if (data && Array.isArray(data.board)) renderBoard(data.board);

      if (data && data.result === 'win') {
        if (data.winner === username) {
          setStatus(' You won!', 'win');
        } else {
          setStatus(` ${data.winner} won.`, 'lose');
        }
      } else if (data && data.result === 'draw') {
        setStatus(" It's a draw.", 'draw');
      } else {
        setStatus('Game finished.', 'info');
      }

     });

    socket.on('opponent_disconnected', (data) => {
      
          // Clear highlights first
      boardCells.forEach(c => c.classList.remove('highlight'));

      if (data?.winner === username) {
        showBanner('Opponent disconnected — you win by forfeit', 'win');
        setStatus('Opponent disconnected — you win by forfeit', 'win');
        addMatchHistory('win', opponentNameSpan.textContent + ' (forfeit)');
      } else {
        showBanner('Opponent disconnected', 'lose');
        setStatus('Opponent disconnected', 'lose');
        addMatchHistory('loss', opponentNameSpan.textContent + ' (forfeit)');
      }

    });

    socket.on('prompt_play_again', (data) => {
      if (!data) return;
      currentRoom = data.room || currentRoom;
      playAgainPrompt.style.display = 'block';
      setStatus(`Play again vs ${data.opponent || 'opponent'}?`, 'info');
    });

    socket.on('return_to_lobby', () => {
      resetGameUI();
      setUIState('lobby');
      document.getElementById('lobbyMsg').textContent = 'Match ended — click Play Game to queue again.';
    });

    socket.on('disconnect', (reason) => {
      if (!username) setUIState('auth');
      setStatus('Disconnected from server', 'info');
      enableBoard(false);
    });

    return socket;
  }

  // Button
  joinBtn.onclick = () => {
    const input = usernameInput.value.trim();
    if (!input) {
      joinStatus.textContent = 'Please enter a username';
      return;
    }

    if (socket && socket.connected) {
      socket.disconnect();
      socket = null;
    }

    ensureSocket();
    // connect and join
    socket.on('connect', () => {
      socket.emit('join', { username: input });
    });

  };

  playBtn.onclick = () => {
    if (!username) {
      const input = usernameInput.value.trim();
      if (!input) return joinStatus.textContent = 'Enter username to play';
      ensureSocket();
      socket.emit('join', { username: input });
      return;
    }
    ensureSocket();
    socket.emit('join', { username });
    document.getElementById('lobbyMsg').textContent = 'You asked to join the queue...';
    playBtn.disabled = true;
  };

  logoutBtn.onclick = () => {
    if (!socket) return;
    socket.emit('logout');
    
  };


  boardCells.forEach(cell => {
    cell.addEventListener('click', () => {
      if (!currentRoom || !myTurn || isGameOver) return;
      const idx = parseInt(cell.dataset.idx);
      if (isNaN(idx)) return;
      socket.emit('move', { room: currentRoom, index: idx });
    });
  });


  playAgainYesBtn.onclick = () => {
    playAgainPrompt.style.display = 'none';
    if (!currentRoom) return;
    socket.emit('play_again_response', { room: currentRoom, play_again: true });
    setStatus('Waiting for opponent response...', 'info');
  };

  playAgainNoBtn.onclick = () => {
    playAgainPrompt.style.display = 'none';
    if (!currentRoom) return;
    socket.emit('play_again_response', { room: currentRoom, play_again: false });

  };

  // initial UI
  setUIState('auth');
  resetGameUI();

});
