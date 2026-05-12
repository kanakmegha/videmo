import os
import sys
import asyncio
from pathlib import Path

# Add the parent directory to sys.path so we can import autonomous_agent
sys.path.append(str(Path(__file__).parent.parent))

try:
    from autonomous_agent import autonomous_flow
except ImportError:
    # Fallback for different deployment structures
    sys.path.append(os.getcwd())
    from autonomous_agent import autonomous_flow

async def handler(req):
    """Vercel serverless handler."""
    # Extract URL from request or use default
    # This is a placeholder for actual request parsing logic
    url = "https://v0.dev" 
    await autonomous_flow(url)
    return {
        "statusCode": 200,
        "body": "Agent execution completed."
    }

if __name__ == "__main__":
    # For local testing of the API wrapper
    asyncio.run(autonomous_flow("https://v0.dev"))
