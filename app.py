import os
import json
import socket
import uuid
import random
import threading
from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room, leave_room, emit


app = Flask(__name__)

app.config['SECRET_KEY'] = 'your-secure-production-secret-key-here'

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

LEADERBOARD_FILE = "leaderboard.json"
lb_lock = threading.Lock()

online_players = {}       # sid -> username
username_to_sid = {}      # username -> sid
queue = []                # list of usernames waiting for a game (FIFO)
rooms = {}                # room_id -> {players: [user1, user2], sids: {...}, board: [...], turn: str, symbols: {...}, finished: bool}

waiting_play_again = {} 


def ensure_leaderboard_exists():
    if not os.path.exists(LEADERBOARD_FILE):
        with open(LEADERBOARD_FILE, "w") as f:
            json.dump({}, f)

def read_leaderboard():
    ensure_leaderboard_exists()
    with lb_lock:
        with open(LEADERBOARD_FILE, "r") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                
                return {}

def write_leaderboard(lb):
    with lb_lock:
        with open(LEADERBOARD_FILE, "w") as f:
            json.dump(lb, f, indent=2)

def ensure_player_in_leaderboard(username):
    lb = read_leaderboard()
    if username not in lb:
        lb[username] = {"games_played": 0, "wins": 0, "losses": 0, "draws": 0}
        write_leaderboard(lb)

def update_leaderboard_result(winner, loser=None, draw=False):
    lb = read_leaderboard()

    def ensure_entry(u):
        if u not in lb:
            lb[u] = {"games_played": 0, "wins": 0, "losses": 0, "draws": 0}

    if draw:
        
        players = winner if isinstance(winner, list) else [winner]
        for u in players:
            ensure_entry(u)
            lb[u]["games_played"] += 1
            lb[u]["draws"] += 1
    else:
        
        if winner:
            ensure_entry(winner)
            lb[winner]["games_played"] += 1
            lb[winner]["wins"] += 1
        if loser:
            ensure_entry(loser)
            lb[loser]["games_played"] += 1
            lb[loser]["losses"] += 1

    write_leaderboard(lb)


def try_pair_players():
   
    while len(queue) >= 2:
       
        a, b = queue[0], queue[1]
        sid_a = username_to_sid.get(a)
        sid_b = username_to_sid.get(b)

        if not sid_a or not sid_b:
            # One or both disconnected while in queue; remove the disconnected ones
            if not sid_a and a in queue: queue.remove(a)
            if not sid_b and b in queue: queue.remove(b)
            # Re-check queue and continue
            continue 

        # Both are online, safely pop them
        queue.pop(0)
        queue.pop(0)
        
        room_id = str(uuid.uuid4())[:8]
        
  
        symbols = {}
        if random.random() < 0.5:
            symbols[a] = "X"
            symbols[b] = "O"
            first = a
        else:
            symbols[a] = "O"
            symbols[b] = "X"
            first = b
        
        rooms[room_id] = {
            "players": [a, b],
            "sids": {a: sid_a, b: sid_b},
            "board": [""]*9,
            "turn": first,
            "symbols": symbols,
            "finished": False
        }

        join_room(room_id, sid=sid_a)
        join_room(room_id, sid=sid_b)

        ensure_player_in_leaderboard(a)
        ensure_player_in_leaderboard(b)

        
        socketio.emit('start_game', {
            "room": room_id,
            "opponent": b,
            "your_symbol": rooms[room_id]["symbols"][a],
            "first_turn": rooms[room_id]["turn"]
        }, to=sid_a)

        socketio.emit('start_game', {
            "room": room_id,
            "opponent": a,
            "your_symbol": rooms[room_id]["symbols"][b],
            "first_turn": rooms[room_id]["turn"]
        }, to=sid_b)

    broadcast_lobby_state()

def broadcast_lobby_state():
    lb = read_leaderboard()
    
    socketio.emit('lobby_update', {
        "queue": queue,
        "leaderboard": lb
    })

def find_room_of_user(username):
    for rid, r in rooms.items():
        if username in r["players"]:
            return rid
    return None

def check_winner(b):
    lines = [
        (0,1,2),(3,4,5),(6,7,8), # Horizontal
        (0,3,6),(1,4,7),(2,5,8), # Vertical
        (0,4,8),(2,4,6)          # Diagonal
    ]
    for a,b2,c in lines:
        if b[a] and b[a] == b[b2] == b[c]:
            return b[a]
    return None



def prompt_play_again(players, room_id): 
    
    r_obj = rooms.get(room_id)
    if not r_obj: return 
    
    waiting_play_again[room_id] = {}
    
    for u in players:
        waiting_play_again[room_id][u] = None 
        
    
    for u in players:
        sid = username_to_sid.get(u)
        if sid:
            opponent = [p for p in players if p != u][0]
           
            socketio.emit('prompt_play_again', {"opponent": opponent, "room": room_id}, to=sid)
  
    broadcast_lobby_state()


def cleanup_room_and_requeue(room_id, requeue_list=None):
    """
    Removes the room from active state and puts players back in queue/lobby.
    :param room_id: The ID of the room to clean up.
    :param requeue_list: List of usernames to put back into the queue.
    """
    requeue_list = requeue_list or []
    r = rooms.pop(room_id, None)
    
    
    waiting_play_again.pop(room_id, None) 
    
    if not r: return
    
   
    for u in r["players"]:
        sid = r["sids"].get(u)
        if sid:
            try:
                
                leave_room(room_id, sid=sid)
            except Exception:
                pass

    
    for u in r["players"]:
        sid = username_to_sid.get(u)
        
        if u in requeue_list: 
            if u not in queue and u in username_to_sid:
                queue.append(u)
        else:
            
            if sid:
                socketio.emit('return_to_lobby', {}, to=sid)
                
    broadcast_lobby_state()
    try_pair_players()




def handle_disconnect_from_room(username, room_id, explicit_logout=False):
    r = rooms.get(room_id)
    if not r: return

    other = [u for u in r["players"] if u != username]
    other = other[0] if other else None

   
    if not r.get("finished", False):

        if other:
            update_leaderboard_result(other, username, draw=False)
            sid_other = username_to_sid.get(other)
            if sid_other:
                
                socketio.emit('opponent_disconnected', {"winner": other, "reason": "opponent_left"}, to=sid_other)

    
    requeue_list = []
    if other and waiting_play_again.get(room_id) and waiting_play_again[room_id].get(other) is True:
        requeue_list.append(other)
        
    cleanup_room_and_requeue(room_id, requeue_list=requeue_list)



@app.route("/")
def index():
    # Assuming you have an index.html in your 'templates' folder
    return render_template("index.html")


@socketio.on('connect')
def on_connect():
    
    pass

@socketio.on('join')
def handle_join(data):
    username = data.get('username', '').strip()
    sid = request.sid
    if not username:
        emit('join_response', {"success": False, "error": "Username required"})
        return

    if username in username_to_sid:
        emit('join_response', {"success": False, "error": "Username already taken"})
        return

    
    online_players[sid] = username
    username_to_sid[username] = sid
    if username not in queue:
        queue.append(username)

    ensure_player_in_leaderboard(username)
    emit('join_response', {"success": True, "username": username})
    
   
    try_pair_players()

@socketio.on('move')
def handle_move(data):
    room = data.get('room')
    idx = data.get('index')
    username = online_players.get(request.sid)
    
   
    if not username or not room or room not in rooms: return
    room_obj = rooms[room]
    if room_obj["finished"] or room_obj["turn"] != username: return
    if not isinstance(idx, int) or not (0 <= idx < 9) or room_obj["board"][idx] != "": return

    symbol = room_obj["symbols"][username]
    room_obj["board"][idx] = symbol
 
    socketio.emit('board_update', {
        "board": room_obj["board"],
        "last_move": {"index": idx, "symbol": symbol}
    }, room=room)

   
    winner_symbol = check_winner(room_obj["board"])
    if winner_symbol:
        winner_user = next((u for u, s in room_obj["symbols"].items() if s == winner_symbol), None)
        loser_user = next((u for u, s in room_obj["symbols"].items() if s != winner_symbol), None)
        
        room_obj["finished"] = True
        update_leaderboard_result(winner_user, loser_user, draw=False)
        socketio.emit('game_over', {"result": "win", "winner": winner_user}, room=room)
        prompt_play_again(room_obj["players"], room)
        return

    
    if all(cell != "" for cell in room_obj["board"]):
        room_obj["finished"] = True
        players = room_obj["players"]
        update_leaderboard_result(players, draw=True)
        socketio.emit('game_over', {"result": "draw"}, room=room)
        prompt_play_again(room_obj["players"], room)
        return

    
    other = [u for u in room_obj["players"] if u != username][0]
    room_obj["turn"] = other
    socketio.emit('turn_update', {"turn": other}, room=room)


@socketio.on('play_again_response')
def handle_play_again(data):
    username = online_players.get(request.sid)
    room_id = data.get('room')
    answer = bool(data.get('play_again'))  

    if not username or not room_id or room_id not in rooms: return
    
    room_obj = rooms[room_id]
    if not room_obj["finished"]: return 

    if room_id in waiting_play_again and username in waiting_play_again[room_id]:
        waiting_play_again[room_id][username] = answer
    else:
        return 

    p1, p2 = room_obj["players"]
    a = waiting_play_again[room_id].get(p1) # p1's answer
    b = waiting_play_again[room_id].get(p2) # p2's answer
    
    
    if a is None or b is None: return

    requeue_list = []
    
    if a and b:
       
        requeue_list = [p1, p2]
    elif a or b:
        
        acceptor = p1 if a else p2
        requeue_list = [acceptor]
    
    cleanup_room_and_requeue(room_id, requeue_list)




@socketio.on('logout')
def handle_logout():
    sid = request.sid
    username = online_players.get(sid)
    if not username: return
    
    
    online_players.pop(sid, None)
    username_to_sid.pop(username, None)
    if username in queue:
        queue.remove(username)
    
    
    room_id = find_room_of_user(username)
    if room_id:
        handle_disconnect_from_room(username, room_id, explicit_logout=True)
        
    emit('logged_out', {})
    broadcast_lobby_state()

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    username = online_players.pop(sid, None)
    if not username: return

    
    username_to_sid.pop(username, None)
    if username in queue:
        try:
            queue.remove(username)
        except ValueError:
            pass
            
    
    room_id = find_room_of_user(username)
    if room_id:
        handle_disconnect_from_room(username, room_id)
        
    broadcast_lobby_state()


if __name__ == '__main__':
    ensure_leaderboard_exists()

  
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)

    print("\nFlask-SocketIO Tic Tac Toe Server Started!")
    print(f"Local access (same PC): http://127.0.0.1:5000")
    print(f"LAN access (same Wi-Fi): http://{local_ip}:5000\n")
    print("Waiting for players to join...\n")

    
    socketio.run(app, host='0.0.0.0', port=5000, debug=True)