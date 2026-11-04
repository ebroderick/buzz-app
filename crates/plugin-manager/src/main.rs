use buzzodz_plugins::{
    managed::{Managed, ManagedState},
    release_manifest, sign_release_saved, valid_id, Catalog, Manager, Manifest, Result,
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    process::Command,
};

const HELP: &str = "buzzodz [--home ABSOLUTE_PATH] [--profile NAME] plugin COMMAND

Commands:
  init DIRECTORY ID NAME   Create a page-plugin source project
  build DIRECTORY          Run the project's pnpm build script
  sign DIST_DIRECTORY       Sign with your saved Buzz human identity
  install DIRECTORY        Install a built artifact (new plugins start disabled)
  reload ID                Reload a folder plugin, preserving its enabled state
  list                     List installed pages and their enabled state
  managed                  Show the managed plugin sources policy and its status
  access [URL]             Show repository access rules and how Git would read URL
  enable ID | disable ID | remove ID | rollback ID
  recover                  Back up settings and reset to bundled defaults

Options:
  --home PATH              Plugin data directory (absolute path)
  --profile NAME           Local profile (default: default)
  --help, -h               Show this help

The desktop and CLI also read BUZZODZ_HOME and BUZZODZ_PROFILE.
BUZZ_MANAGED_PLUGINS overrides the managed plugin policy file location.
BUZZ_REPOSITORY_ACCESS overrides the repository access rules file location.
Launch the desktop with BUZZODZ_SAFE_MODE=1 to skip external pages.";

fn main() {
    if let Err(message) = run() {
        eprintln!("Error: {message}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return Ok(());
    }
    let mut home = None;
    let mut profile = std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into());
    while args.first().is_some_and(|s| s.starts_with("--")) {
        let flag = args.remove(0);
        if args.is_empty() {
            return Err(format!("{flag} requires a value. See buzzodz --help."));
        }
        let value = args.remove(0);
        match flag.as_str() {
            "--home" => home = Some(PathBuf::from(value)),
            "--profile" => profile = value,
            _ => return Err(format!("Unknown option {flag}. See buzzodz --help.")),
        }
    }
    if args.first().map(String::as_str) != Some("plugin") || args.len() < 2 {
        return Err("Expected plugin COMMAND. See buzzodz --help.".into());
    }
    let action = &args[1];
    let rest = &args[2..];
    // Source creation/building does not require a local installation profile.
    match (action.as_str(), rest) {
        ("init", [directory, id, name]) => {
            init(Path::new(directory), id, name)?;
            println!("Created {id} in {directory}\nNext: add the host-matched @buzz/author preview archive with pnpm add -D /absolute/path/buzz-author-VERSION.tgz, then buzzodz plugin build DIRECTORY.");
            return Ok(());
        }
        ("build", [directory]) => {
            build(Path::new(directory))?;
            println!("Built {}", Path::new(directory).join("dist").display());
            return Ok(());
        }
        ("sign", [directory]) => {
            let publisher = sign_release_saved(Path::new(directory))?;
            println!("Signed release in {directory} by {publisher}");
            return Ok(());
        }
        ("sign", _) => return Err("Usage: buzzodz plugin sign DIST_DIRECTORY".into()),
        _ => {}
    }
    let manager = Manager::open(home, &profile, false)?;
    match (action.as_str(), rest) {
        ("install", [directory]) => {
            let manifest = release_manifest(Path::new(directory))?;
            let catalog = manager.install(Path::new(directory))?;
            let installed = catalog
                .plugins
                .iter()
                .find(|p| p.manifest.id == manifest.id)
                .ok_or("Installed plugin missing from catalog")?;
            println!(
                "Installed {} ({}) in profile {profile}. Publisher: {}",
                installed.manifest.id,
                if installed.enabled {
                    "enabled"
                } else {
                    "disabled"
                },
                installed.publisher.as_deref().unwrap_or("unsigned")
            );
        }
        ("reload", [id]) => {
            let before = manager.catalog()?;
            let after = manager.reload_live(id)?;
            for (label, catalog) in [
                ("Previous host access", &before),
                ("Updated host access", &after),
            ] {
                let grants = catalog
                    .plugins
                    .iter()
                    .find(|p| p.manifest.id == *id)
                    .and_then(|p| p.manifest.host.as_ref());
                println!(
                    "{label}: {}",
                    serde_json::to_string_pretty(&grants).map_err(|e| e.to_string())?
                );
            }
            println!("Reloaded {id} in profile {profile}. The running app picks up changed builds automatically.");
        }
        ("reload", _) => return Err("Usage: buzzodz plugin reload ID".into()),
        ("list", []) => print_catalog(&manager.catalog()?)?,
        ("managed", []) => print_managed(&manager.managed(&manager.catalog()?)),
        ("access", [] | [_]) => {
            let home = dirs::home_dir().ok_or("Cannot find the home directory")?;
            print!(
                "{}",
                manager
                    .repository_access()
                    .describe(rest.first().map(String::as_str), &home)?
            );
        }
        ("access", _) => return Err("Usage: buzzodz plugin access [URL]".into()),
        ("recover", []) => {
            let catalog = manager.recover()?;
            println!("Reset profile {profile} to bundled defaults.\nAny previous settings were backed up in {}.\nExternal artifacts remain available for reinstallation.", catalog.location);
        }
        ("enable" | "disable" | "remove" | "rollback", [id]) => {
            manager.change(action, id)?;
            let verb = match action.as_str() {
                "enable" => "Enabled",
                "disable" => "Disabled",
                "remove" => "Removed",
                _ => "Rolled back",
            };
            println!("{verb} {id} in profile {profile}.");
        }
        _ => {
            return Err(format!(
                "Unknown command or incorrect arguments: plugin {}. See buzzodz --help.",
                args[1..].join(" ")
            ))
        }
    }
    Ok(())
}
fn print_catalog(catalog: &Catalog) -> Result<()> {
    println!(
        "Profile: {}\nDirectory: {}\n",
        catalog.profile, catalog.location
    );
    for plugin in &catalog.plugins {
        println!(
            "{:<24} {:<10} {:<10} {}",
            plugin.manifest.id,
            if plugin.enabled {
                "enabled"
            } else {
                "disabled"
            },
            plugin.source,
            plugin.manifest.name
        );
        if let Some(error) = &plugin.error {
            println!("  Problem: {error}");
        }
        if plugin.source == "external" {
            println!(
                "  Publisher: {}",
                plugin
                    .publisher
                    .as_deref()
                    .unwrap_or(if plugin.error.is_some() {
                        "unverified"
                    } else {
                        "unsigned"
                    })
            );
        }
    }
    Ok(())
}
fn print_managed(managed: &Managed) {
    match managed {
        Managed::Absent => println!("No managed plugin policy found."),
        Managed::Invalid { path, reason } => {
            println!("Policy: {path}\nStatus: unusable\nProblem: {reason}")
        }
        Managed::Ready {
            path,
            source,
            plugins,
            problems,
        } => {
            println!("Policy: {path}\nManaged by: {source}\n");
            for entry in plugins {
                let state = match entry.state {
                    ManagedState::Missing => "not installed",
                    ManagedState::Current => "installed, current",
                    ManagedState::Outdated => "installed, update available",
                    ManagedState::Other => "installed from another source",
                };
                let plugin = &entry.plugin;
                println!(
                    "{:<24} {}\n  {} {} {} ({})",
                    plugin.id,
                    state,
                    plugin.repository,
                    plugin.reference,
                    plugin.commit,
                    plugin.path
                );
            }
            for problem in problems {
                println!("Ignored: {problem}");
            }
        }
    }
}
fn read_manifest(directory: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(
        &std::fs::read(directory.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    manifest.validate()?;
    Ok(manifest)
}
fn init(directory: &Path, id: &str, name: &str) -> Result<()> {
    valid_id(id)?;
    let manifest = Manifest {
        id: id.into(),
        name: name.into(),
        api_version: 1,
        description: None,
        discovery: None,
        host: None,
    };
    manifest.validate()?;
    // Never overwrite an existing source directory.
    std::fs::create_dir(directory).map_err(|e| e.to_string())?;
    std::fs::create_dir(directory.join("src")).map_err(|e| e.to_string())?;
    let package = json!({"name": id, "private": true, "type": "module", "scripts": {"build": "tsc && vite build"}, "devDependencies": {"vite": "8.2.2", "typescript": "7.0.2", "@types/react": "19.2.18"}, "engines": {"node": ">=24"}});
    for (file, text) in [
        ("manifest.json", serde_json::to_string_pretty(&manifest).unwrap()),
        ("package.json", serde_json::to_string_pretty(&package).unwrap()),
        (".gitignore", "node_modules/\ndist/\n".into()),
        ("tsconfig.json", r#"{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","jsx":"react","strict":true,"noEmit":true},"include":["src"]}"#.into()),
        ("src/index.tsx", r#"import type { Context } from '@buzz/author';

export const inject = ['react', 'pages'];

export function apply(ctx: Context) {
  const React = ctx.react;
  // Plugin resources belong in ctx.effect(() => cleanup).
  // React effects belong to the visible page and stop when navigating away.
  // primary gives the page a sidebar row; every active page is still listed in search.
  ctx.pages.register({ id: "main", title: "My page", primary: true, component: function Page() {
    const [count, setCount] = React.useState(0);
    return <section>
      <h1>My page</h1>
      <button type='button' onClick={() => setCount(count + 1)}>Clicked {count} times</button>
    </section>;
  }});
}
"#.into()),
        // A normal, editable Vite config in the author's project, not injected code.
        ("vite.config.ts", r#"import { defineConfig } from 'vite';
import manifest from './manifest.json';

export default defineConfig({
  publicDir: false,
  oxc: { jsx: { runtime: 'classic' } },
  build: {
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: () => 'plugin.js' },
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [{
    name: 'page-contract',
    enforce: 'pre',
    resolveId(id) {
      if (/^react(?:-dom)?(?:\/|$)/.test(id) || id === '@buzz/author' || id === '@deepseek-ai/cordis' || id.startsWith('@deepseek-ai/cordis/')) {
        throw new Error('Host capabilities are supplied by Buzz; use type-only imports');
      }
    },
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle);
      const page = outputs[0];
      if (outputs.length !== 1 || page?.type !== 'chunk' || page.imports.length) {
        throw new Error('Page API v1 requires one self-contained JS module, without separate assets');
      }
      if (!page.exports.includes('apply')) throw new Error('Export apply(ctx)');
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
    },
  }],
});
"#.into()),
    ] { std::fs::write(directory.join(file), text).map_err(|e| e.to_string())?; }
    Ok(())
}
fn build(directory: &Path) -> Result<()> {
    read_manifest(directory)?;
    let status = Command::new(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" })
        .args(["run", "build"])
        .current_dir(directory)
        .status()
        .map_err(|e| {
            format!("Could not start pnpm: {e}. Install Node and pnpm to build plugins.")
        })?;
    if !status.success() {
        return Err("Plugin build failed. See the build output above.".into());
    }
    // A successful script must actually produce the artifact that install consumes.
    read_manifest(&directory.join("dist"))?;
    if !directory.join("dist/plugin.js").is_file() {
        return Err("Build did not produce dist/plugin.js".into());
    }
    Ok(())
}
