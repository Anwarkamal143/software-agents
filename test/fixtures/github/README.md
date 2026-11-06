# Recorded GitHub API responses

Response bodies in the shapes GitHub's REST API (version `2022-11-28`) and GraphQL API return,
one file per kind, trimmed to the fields the Factory reads plus enough of the rest to stay
realistic. `test/fakes/github.ts` replays them, overriding numbers, logins, labels and times per
test, and adds the headers GitHub sends (`ETag`, `X-RateLimit-Remaining`, `Link`). Tests never
call the live API.
