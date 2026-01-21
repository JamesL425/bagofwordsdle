#!/usr/bin/env python3
"""
Matchmaking Test Script for Bagofwordsdle

This script allows you to test the matchmaking queue system by simulating
multiple players joining the queue from a single machine.

HOW THE MATCHMAKING SYSTEM WORKS:
================================

1. QUICK PLAY MODE:
   - Players join a FIFO (first-in-first-out) queue
   - Target match size: 4 players
   - After 30s wait: accepts 3-player matches
   - After 60s wait: accepts 2-player matches
   - Queue expires after 5 minutes

2. RANKED MODE:
   - Players are sorted by MMR (matchmaking rating)
   - Always requires exactly 4 human players (no AI)
   - MMR range expands over time:
     * Initial: +/- 150 MMR
     * After 15s: +/- 250 MMR
     * After 30s: +/- 400 MMR
     * After 45s: +/- 600 MMR
     * After 60s: +/- 800 MMR
     * After 90s: +/- 1000 MMR (matches anyone)
   - Requires 3 casual games played first
   - Requires Google authentication

USAGE:
======
# Test quick play with 2 simulated players
python test_matchmaking.py quick_play --players 2

# Test quick play with 4 simulated players (instant match)
python test_matchmaking.py quick_play --players 4

# Test with custom API base URL
python test_matchmaking.py quick_play --players 2 --api http://localhost:3000

# Watch queue status without joining
python test_matchmaking.py status

# Clean up any stuck queue entries
python test_matchmaking.py cleanup
"""

import argparse
import asyncio
import aiohttp
import json
import time
import sys
from typing import Optional, Dict, Any, List
from dataclasses import dataclass


# Default API base - use production since local dev requires `vercel dev`
DEFAULT_API_BASE = "https://www.embeddle.io"


@dataclass
class SimulatedPlayer:
    """Represents a simulated player in the queue."""
    name: str
    player_id: Optional[str] = None
    mode: str = "quick_play"
    status: str = "idle"
    game_code: Optional[str] = None
    session_token: Optional[str] = None
    joined_at: Optional[float] = None


async def api_call(
    session: aiohttp.ClientSession,
    api_base: str,
    endpoint: str,
    method: str = "GET",
    data: Optional[Dict] = None,
) -> Dict[str, Any]:
    """Make an API call."""
    url = f"{api_base}{endpoint}"
    
    try:
        if method == "GET":
            async with session.get(url) as resp:
                return await resp.json()
        else:
            async with session.post(url, json=data) as resp:
                return await resp.json()
    except aiohttp.ClientError as e:
        return {"error": str(e)}
    except json.JSONDecodeError:
        return {"error": "Invalid JSON response"}


async def join_queue(
    session: aiohttp.ClientSession,
    api_base: str,
    player: SimulatedPlayer,
) -> bool:
    """Join the matchmaking queue."""
    result = await api_call(
        session, api_base, "/api/queue/join", "POST",
        {"mode": player.mode, "player_name": player.name}
    )
    
    if result.get("status") == "queued":
        player.player_id = result.get("player_id")
        player.status = "queued"
        player.joined_at = time.time()
        print(f"  ✓ {player.name} joined {player.mode} queue (ID: {player.player_id[:8]}...)")
        return True
    else:
        print(f"  ✗ {player.name} failed to join: {result}")
        return False


async def poll_queue_status(
    session: aiohttp.ClientSession,
    api_base: str,
    player: SimulatedPlayer,
) -> Dict[str, Any]:
    """Poll queue status for a player."""
    if not player.player_id:
        return {"status": "not_joined"}
    
    result = await api_call(
        session, api_base,
        f"/api/queue/status?mode={player.mode}&player_id={player.player_id}"
    )
    return result


async def leave_queue(
    session: aiohttp.ClientSession,
    api_base: str,
    player: SimulatedPlayer,
) -> bool:
    """Leave the matchmaking queue."""
    if not player.player_id:
        return True
    
    result = await api_call(
        session, api_base, "/api/queue/leave", "POST",
        {"mode": player.mode, "player_id": player.player_id}
    )
    
    player.status = "idle"
    return result.get("status") == "left"


async def get_queue_counts(
    session: aiohttp.ClientSession,
    api_base: str,
) -> Dict[str, int]:
    """Get current queue sizes."""
    result = await api_call(session, api_base, "/api/queue/counts")
    return {
        "quick_play": result.get("quick_play", 0),
        "ranked": result.get("ranked", 0),
    }


async def simulate_matchmaking(
    api_base: str,
    mode: str,
    num_players: int,
    timeout: int = 120,
):
    """
    Simulate multiple players joining the matchmaking queue.
    
    This is the main test function that:
    1. Creates N simulated players
    2. Has them all join the queue
    3. Polls until they get matched or timeout
    """
    print(f"\n{'='*60}")
    print(f"MATCHMAKING TEST: {mode.upper()}")
    print(f"{'='*60}")
    print(f"Simulating {num_players} players")
    print(f"API Base: {api_base}")
    print(f"Timeout: {timeout}s")
    print()
    
    # Create simulated players
    players = [
        SimulatedPlayer(name=f"TestPlayer{i+1}", mode=mode)
        for i in range(num_players)
    ]
    
    async with aiohttp.ClientSession() as session:
        # Check initial queue state
        counts = await get_queue_counts(session, api_base)
        print(f"Current queue sizes: Quick Play={counts['quick_play']}, Ranked={counts['ranked']}")
        print()
        
        # Join all players to queue
        print("Joining players to queue...")
        join_tasks = [join_queue(session, api_base, p) for p in players]
        await asyncio.gather(*join_tasks)
        
        queued_players = [p for p in players if p.status == "queued"]
        print(f"\n{len(queued_players)}/{num_players} players successfully queued")
        
        if not queued_players:
            print("No players in queue, aborting test")
            return
        
        # Poll for matches
        print(f"\nPolling for matches (timeout: {timeout}s)...")
        print("-" * 40)
        
        start_time = time.time()
        matched_players = []
        
        while queued_players and (time.time() - start_time) < timeout:
            elapsed = time.time() - start_time
            
            # Poll all queued players
            for player in list(queued_players):
                status = await poll_queue_status(session, api_base, player)
                
                if status.get("status") == "matched":
                    player.status = "matched"
                    player.game_code = status.get("game_code")
                    player.session_token = status.get("session_token")
                    matched_players.append(player)
                    queued_players.remove(player)
                    print(f"  🎮 {player.name} MATCHED! Game: {player.game_code}")
                
                elif status.get("status") == "not_in_queue":
                    player.status = "dropped"
                    queued_players.remove(player)
                    print(f"  ❌ {player.name} dropped from queue")
                
                else:
                    # Still waiting
                    queue_size = status.get("queue_size", "?")
                    wait_time = int(time.time() - (player.joined_at or time.time()))
                    
                    if mode == "quick_play":
                        min_size = status.get("min_match_size", 4)
                        print(f"  ⏳ {player.name}: waiting {wait_time}s, queue={queue_size}, min_size={min_size}")
                    else:
                        mmr_range = status.get("mmr_range", "?")
                        print(f"  ⏳ {player.name}: waiting {wait_time}s, queue={queue_size}, MMR range=+/-{mmr_range}")
            
            if queued_players:
                print(f"  --- Elapsed: {int(elapsed)}s ---")
                await asyncio.sleep(3)  # Poll every 3 seconds
        
        # Summary
        print()
        print("=" * 40)
        print("TEST RESULTS")
        print("=" * 40)
        print(f"Total players: {num_players}")
        print(f"Matched: {len(matched_players)}")
        print(f"Still waiting: {len(queued_players)}")
        print(f"Dropped: {len([p for p in players if p.status == 'dropped'])}")
        
        if matched_players:
            print(f"\nMatched games:")
            game_codes = set(p.game_code for p in matched_players)
            for code in game_codes:
                players_in_game = [p.name for p in matched_players if p.game_code == code]
                print(f"  Game {code}: {', '.join(players_in_game)}")
        
        # Cleanup - leave any remaining queued players
        if queued_players:
            print(f"\nCleaning up {len(queued_players)} remaining players...")
            for player in queued_players:
                await leave_queue(session, api_base, player)


async def watch_queue_status(api_base: str, duration: int = 60):
    """Watch queue status without joining."""
    print(f"\n{'='*60}")
    print("QUEUE STATUS MONITOR")
    print(f"{'='*60}")
    print(f"Watching for {duration}s...")
    print()
    
    async with aiohttp.ClientSession() as session:
        start_time = time.time()
        
        while (time.time() - start_time) < duration:
            counts = await get_queue_counts(session, api_base)
            elapsed = int(time.time() - start_time)
            print(f"[{elapsed:3d}s] Quick Play: {counts['quick_play']:2d} | Ranked: {counts['ranked']:2d}")
            await asyncio.sleep(2)


async def interactive_test(api_base: str, mode: str):
    """
    Interactive test mode - simulates being a single player in queue.
    
    This lets you test the queue from one terminal while joining
    from the actual frontend in another browser window.
    """
    print(f"\n{'='*60}")
    print(f"INTERACTIVE QUEUE TEST: {mode.upper()}")
    print(f"{'='*60}")
    print()
    print("This mode simulates ONE player in the queue.")
    print("Open your browser and join the same queue to test matching!")
    print()
    print("Press Ctrl+C to leave the queue and exit.")
    print()
    
    player = SimulatedPlayer(name="TestBot", mode=mode)
    
    async with aiohttp.ClientSession() as session:
        # Join queue
        if not await join_queue(session, api_base, player):
            return
        
        print(f"\n{player.name} is now in the {mode} queue!")
        print("Waiting for match...")
        print("-" * 40)
        
        try:
            while player.status == "queued":
                status = await poll_queue_status(session, api_base, player)
                
                if status.get("status") == "matched":
                    player.status = "matched"
                    player.game_code = status.get("game_code")
                    print(f"\n🎮 MATCH FOUND!")
                    print(f"   Game Code: {player.game_code}")
                    print(f"   Session Token: {status.get('session_token', 'N/A')[:20]}...")
                    break
                
                elif status.get("status") == "not_in_queue":
                    print("\n❌ Removed from queue!")
                    break
                
                else:
                    wait_time = int(time.time() - (player.joined_at or time.time()))
                    queue_size = status.get("queue_size", "?")
                    
                    if mode == "quick_play":
                        min_size = status.get("min_match_size", 4)
                        print(f"⏳ Waiting: {wait_time}s | Queue: {queue_size} | Min size: {min_size}")
                    else:
                        mmr_range = status.get("mmr_range", "?")
                        print(f"⏳ Waiting: {wait_time}s | Queue: {queue_size} | MMR: +/-{mmr_range}")
                
                await asyncio.sleep(2)
        
        except KeyboardInterrupt:
            print("\n\nLeaving queue...")
            await leave_queue(session, api_base, player)
            print("Done!")


def main():
    parser = argparse.ArgumentParser(
        description="Test matchmaking queue system",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Command to run")
    
    # Quick play test
    qp_parser = subparsers.add_parser("quick_play", help="Test quick play matchmaking")
    qp_parser.add_argument("--players", "-p", type=int, default=2, help="Number of simulated players")
    qp_parser.add_argument("--api", type=str, default=DEFAULT_API_BASE, help="API base URL")
    qp_parser.add_argument("--timeout", "-t", type=int, default=120, help="Timeout in seconds")
    
    # Ranked test (note: requires auth, so limited testing)
    ranked_parser = subparsers.add_parser("ranked", help="Test ranked matchmaking (limited without auth)")
    ranked_parser.add_argument("--players", "-p", type=int, default=4, help="Number of simulated players")
    ranked_parser.add_argument("--api", type=str, default=DEFAULT_API_BASE, help="API base URL")
    ranked_parser.add_argument("--timeout", "-t", type=int, default=120, help="Timeout in seconds")
    
    # Interactive mode
    interactive_parser = subparsers.add_parser("interactive", help="Interactive single-player queue test")
    interactive_parser.add_argument("--mode", "-m", choices=["quick_play", "ranked"], default="quick_play")
    interactive_parser.add_argument("--api", type=str, default=DEFAULT_API_BASE, help="API base URL")
    
    # Status monitor
    status_parser = subparsers.add_parser("status", help="Watch queue status")
    status_parser.add_argument("--api", type=str, default=DEFAULT_API_BASE, help="API base URL")
    status_parser.add_argument("--duration", "-d", type=int, default=60, help="Watch duration in seconds")
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        print("\n" + "="*60)
        print("QUICK START:")
        print("="*60)
        print("  python test_matchmaking.py quick_play --players 4")
        print("  python test_matchmaking.py interactive --mode quick_play")
        print("  python test_matchmaking.py status")
        return
    
    if args.command == "quick_play":
        asyncio.run(simulate_matchmaking(args.api, "quick_play", args.players, args.timeout))
    
    elif args.command == "ranked":
        print("Note: Ranked matchmaking requires authentication.")
        print("Simulated players won't have auth tokens, so matches may fail.")
        print("Use interactive mode + browser for full ranked testing.")
        asyncio.run(simulate_matchmaking(args.api, "ranked", args.players, args.timeout))
    
    elif args.command == "interactive":
        asyncio.run(interactive_test(args.api, args.mode))
    
    elif args.command == "status":
        asyncio.run(watch_queue_status(args.api, args.duration))


if __name__ == "__main__":
    main()

