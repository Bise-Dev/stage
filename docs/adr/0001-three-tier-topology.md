# Three-tier topology: client ⇄ Stage backend ⇄ GitHub

Stage is split into three entities — a local client, a Stage backend, and GitHub — with a strict shape: the client only talks to the Stage backend, and the Stage backend is the only thing that talks to GitHub. The client gets data from local git or from the Stage backend API, which aggregates Stage-owned data (storyline, etc.) with data brokered from GitHub.

We chose this over a two-tier design (client talks to GitHub directly + stores storyline in git refs) because the storyline and any future Stage-native data need a real home that is not on the user's branch, and because routing GitHub API access through our backend lets us aggregate, cache, and enforce the "review actions sync back to GitHub" rule in one place. Cost: we own a server even at POC stage; the client has no offline GitHub fallback.
