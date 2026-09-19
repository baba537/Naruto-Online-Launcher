# Flash plugin

PPAPI Flash, bundled with the release builds:

| System | File | Version | SHA-256 |
|---|---|---|---|
| Windows x64 | `pepflashplayer.dll` | 34.0.0.376 | `cb91e4589f0a854dd0f23a21d6feee623a857a1dee112b8cb5e5a7c9be0af6f2` |
| Linux x64 | `libpepflashplayer.so` | 34.0.0.137 | `e66c93332824bce66cb862a0b7d5b175f9d5d78b296c1524dfa393ee516b0a7d` |

The launcher refuses to load a bundled file whose hash does not match.

To try a different build, import it under *System → Import plugin file* instead of replacing these files. An imported plugin takes priority over the bundled one.

The plugin is Adobe software and not covered by the project's MIT license.
