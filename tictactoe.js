const { v4: uuidv4 } = require('uuid');

const WIN_PATTERNS = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

class TicTacToeService {
  constructor() {
    this.queue = [];
    this.games = new Map();
    this.userToGame = new Map();
  }

  queueUser(user) {
    const existingGame = this.userToGame.get(user.id);
    if (existingGame) {
      return { status: 'in_game', game: existingGame };
    }

    if (this.queue.find((u) => u.id === user.id)) {
      return { status: 'waiting' };
    }

    if (this.queue.length > 0) {
      const opponent = this.queue.shift();
      const game = this.createGame(opponent, user);
      return { status: 'matched', game };
    }

    this.queue.push(user);
    return { status: 'waiting' };
  }

  leave(userId) {
    const existingGame = this.userToGame.get(userId);
    if (existingGame) {
      const winner = this.getOpponentSymbol(existingGame, userId);
      this.finishGame(existingGame, { winner, forfeit: true });
      return { resigned: true, game: existingGame };
    }

    const wasQueued = this.queue.some((user) => user.id === userId);
    this.queue = this.queue.filter((user) => user.id !== userId);
    return { queueLeft: wasQueued };
  }

  getState(userId) {
    const game = this.userToGame.get(userId);
    return {
      queue: this.queue.some((user) => user.id === userId),
      game: game || null
    };
  }

  makeMove(userId, cellIndex) {
    const game = this.userToGame.get(userId);
    if (!game || game.status !== 'active') {
      return { error: 'No active game' };
    }

    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) {
      return { error: 'Invalid cell' };
    }

    const symbol = this.getSymbolForUser(game, userId);
    if (!symbol) {
      return { error: 'Invalid player' };
    }

    if (game.board[cellIndex]) {
      return { error: 'Cell taken' };
    }

    if (game.next !== symbol) {
      return { error: 'Not your turn' };
    }

    game.board[cellIndex] = symbol;
    game.updatedAt = new Date().toISOString();

    const winner = this.checkWinner(game.board);
    if (winner) {
      this.finishGame(game, { winner });
    } else if (game.board.every(Boolean)) {
      this.finishGame(game, { winner: null, draw: true });
    } else {
      game.next = symbol === 'X' ? 'O' : 'X';
    }

    return { game };
  }

  createGame(playerOne, playerTwo) {
    const game = {
      id: uuidv4(),
      players: {
        X: playerOne,
        O: playerTwo
      },
      board: Array(9).fill(''),
      next: 'X',
      status: 'active',
      winner: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.games.set(game.id, game);
    this.userToGame.set(playerOne.id, game);
    this.userToGame.set(playerTwo.id, game);
    return game;
  }

  finishGame(game, { winner = null, draw = false, forfeit = false } = {}) {
    game.status = 'finished';
    game.winner = winner;
    game.draw = draw;
    game.forfeit = forfeit;
    game.finishedAt = new Date().toISOString();
    this.userToGame.delete(game.players.X.id);
    this.userToGame.delete(game.players.O.id);
    return game;
  }

  getSymbolForUser(game, userId) {
    if (game.players.X.id === userId) return 'X';
    if (game.players.O.id === userId) return 'O';
    return null;
  }

  getOpponentSymbol(game, userId) {
    const symbol = this.getSymbolForUser(game, userId);
    if (!symbol) return null;
    return symbol === 'X' ? 'O' : 'X';
  }

  checkWinner(board) {
    for (const pattern of WIN_PATTERNS) {
      const [a, b, c] = pattern;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return board[a];
      }
    }
    return null;
  }
}

module.exports = new TicTacToeService();
