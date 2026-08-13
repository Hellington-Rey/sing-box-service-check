"""Assemble deployable monoliths from maintainable source fragments."""

import argparse
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

TARGETS = [
    {
        "target": ROOT / "files/usr/lib/forkop-servicecheck/probe.uc",
        "parts": ROOT / "src/backend",
        "boundaries": [
            ("00_core.part", None),
            ("10_network.part", "// ---------------------------------------------------------------------------\n// Сеть: разбор адресов"),
            ("20_environment.part", "// ---------------------------------------------------------------------------\n// Окружение роутера"),
            ("30_profiles.part", "// ---------------------------------------------------------------------------\n// Профили"),
            ("40_probes.part", "// ---------------------------------------------------------------------------\n// Пробы"),
            ("50_routes.part", "// ---------------------------------------------------------------------------\n// Определение маршрута через Clash API"),
            ("60_verdicts.part", "// ---------------------------------------------------------------------------\n// Вердикты"),
            ("70_runner.part", "// ---------------------------------------------------------------------------\n// Запуск проверки"),
            ("80_updater.part", "// ---------------------------------------------------------------------------\n// Безопасное самообновление из GitHub Releases"),
            ("90_jobs.part", "// ---------------------------------------------------------------------------\n// Фоновые задания"),
            ("99_cli.part", "let mode = as_string(ARGV[0]);"),
        ],
    },
    {
        "target": ROOT / "files/www/luci-static/resources/view/forkop/servicecheck-v112.js",
        "parts": ROOT / "src/luci",
        "boundaries": [
            ("00_core_and_styles.part", None),
            ("10_result_rendering.part", "function formatMs(value)"),
            ("20_reports_and_history.part", "function sanitizedReport(state, moduleVersion)"),
            ("30_view_setup.part", "return view.extend({"),
            ("40_jobs.part", "    var runButton = E(\"button\", { class: \"cbi-button cbi-button-action important\" }, \"Проверить сервис\");"),
            ("50_update_and_diagnostics.part", "    var updateStatusNode = E(\"div\", { class: \"fkpsc-update-status\" }, ["),
            ("60_tabs.part", "    var checkTab = E(\"button\", { class: \"fkpsc-tab active\""),
            ("70_profiles.part", "    var profilesCardsNode = E(\"div\", {});"),
            ("80_theme_and_layout.part", "    function showPage(name)"),
        ],
    },
]


def normalized_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


def bootstrap(config: dict) -> None:
    source = normalized_text(config["target"])
    boundaries = config["boundaries"]
    positions = [0]
    for _, marker in boundaries[1:]:
        position = source.find(marker)
        if position < 0:
            raise ValueError(f"marker not found in {config['target']}: {marker}")
        positions.append(position)
    positions.append(len(source))

    config["parts"].mkdir(parents=True, exist_ok=True)
    for index, (name, _) in enumerate(boundaries):
        (config["parts"] / name).write_text(
            source[positions[index]:positions[index + 1]], encoding="utf-8", newline="\n"
        )


def assembled(config: dict) -> str:
    names = [name for name, _ in config["boundaries"]]
    return "".join(normalized_text(config["parts"] / name) for name in names)


def assemble_all(check: bool = False) -> None:
    for config in TARGETS:
        expected = assembled(config)
        current = normalized_text(config["target"])
        if check:
            if current != expected:
                raise ValueError(f"generated source is stale: {config['target']}")
        elif current != expected:
            config["target"].write_text(expected, encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bootstrap", action="store_true", help="split current generated files into fragments")
    parser.add_argument("--check", action="store_true", help="fail if generated files differ from fragments")
    args = parser.parse_args()
    if args.bootstrap:
        for config in TARGETS:
            bootstrap(config)
    assemble_all(check=args.check)
    print("source assembly OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
