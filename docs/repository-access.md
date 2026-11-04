# Repository access rules

Plugin imports run Git without the user's Git or SSH configuration, credential helpers
or prompts, so setups that make `git clone` work in a terminal do not apply to them.
Examples are an `insteadOf` rule that rewrites HTTPS URLs to SSH, or an `IdentityAgent`
line that selects an SSH agent. A repository access file declares the same access for
Buzz: which sources are read over which SSH user and agent socket.

A rule can change only the scheme, the SSH user and the agent socket. The host, port
and path stay as entered, the saved plugin source keeps the URL the user entered, and
no programs, helpers or SSH config are run.

## File location

`repository-access.json` lives in the app data folder beside `managed-plugins.json`;
see [managed plugin sources](managed-plugins.md#file-location) for the folder on each
OS and for `BUZZODZ_HOME`. `BUZZ_REPOSITORY_ACCESS`, when set and non-empty, is the
full path of the file and must be absolute. Buzz reads the file on every Git import,
so an edited file applies to the next Add, check or Update.

Write UTF-8 JSON, at most 64 KiB, as a regular file, the same way as the managed plugin
file. A missing file means only the built-in rules apply.

## Schema (version 1)

```json
{
  "version": 1,
  "builtInRules": true,
  "rules": [
    {
      "host": "git.example.com",
      "pathPrefix": "/team/",
      "sshUser": "git",
      "sshAgentSocket": "~/.ssh/team-agent.sock",
      "rewriteHttps": true,
      "platforms": ["macos", "linux"]
    },
    {
      "host": "github.com",
      "pathPrefix": "/example-org/",
      "sshUser": "git"
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Must be `1`. |
| `builtInRules` | no, default `true` | `false` turns off the rules built into Buzz. |
| `rules` | no | At most 32 rules; later ones are ignored with a problem. |
| `host` | yes | Lowercase host name, no port. |
| `pathPrefix` | yes | Starts and ends with `/`; no `%`, `..` segment or whitespace. |
| `sshUser` | yes | 1 to 64 letters, digits, `.`, `_` or `-`, not starting with `-`. |
| `sshAgentSocket` | no | Absolute path, or a path starting with `~/`. Not supported on Windows. Without it, the agent in Buzz's inherited `SSH_AUTH_SOCK` is used. |
| `rewriteHttps` | no, default `true` | Read matching HTTPS sources over SSH. |
| `platforms` | no, default all | Any of `macos`, `linux`, `windows`. |

Unknown fields are ignored. A rule with an invalid field is ignored and reported; the
other rules still apply. A file that cannot be read as UTF-8 JSON of this shape, such
as one that is too large, has another or no `version`, or has a `rules` or
`builtInRules` value of the wrong type, is unusable, and only the built-in rules apply.

## Matching

Rules from the file are tried in order, then the built-in rules; the first that applies
wins. A rule applies to a source when the platform matches, the host is equal, the path
starts with `pathPrefix` and contains no `%`, and either:

- the source is `ssh://<sshUser>@<host>/…` on the default port or 22, or
- the source is `https://<host>/…` on the default port, `rewriteHttps` is true, and the
  source is not a community repository authorized by the relay. Git then reads
  `ssh://<sshUser>@<host><path>`.

A rule whose `sshAgentSocket` does not exist, or a rule without one while
`SSH_AUTH_SOCK` is unset, does not apply, so public repositories stay readable over
HTTPS. A socket path that exists but is not a socket fails the import. When a matched
rule's read fails, the error names the rule and agent socket.

When a rule applies to an HTTPS prefix, every repository under it, public ones too, is
read over SSH and needs a working agent. Set `rewriteHttps` to `false` to use a rule
only for SSH sources. Such a rule does not stop a later rule, including a built-in
one, from reading the same HTTPS sources over SSH; set `builtInRules` to `false` for that.

## Built-in rules

On macOS, `github.com/squareup/` is read as `org-49461806` with the agent at
`~/Library/Application Support/block-ssh-agent/agent.sock`, when that socket exists.

## Inspecting rules

```sh
buzzodz plugin access
buzzodz plugin access https://git.example.com/team/plugin.git
BUZZ_REPOSITORY_ACCESS=/tmp/access.json buzzodz plugin access
```

The first form prints the file, its status, the rules in the order they are tried and
any problems. With a URL it also prints the matching rule, the URL Git reads and the
agent socket.
