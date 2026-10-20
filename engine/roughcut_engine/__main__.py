import os

import uvicorn

PORT = int(os.environ.get("RC_ENGINE_PORT", "7317"))


def main() -> None:
    uvicorn.run("roughcut_engine.app:app", host="127.0.0.1", port=PORT)


if __name__ == "__main__":
    main()
