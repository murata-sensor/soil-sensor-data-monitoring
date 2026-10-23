import subprocess

import pytest

from scripts import check_no_pii


@pytest.mark.parametrize("secret", [
    "-----BEGIN " + "PRIVATE KEY-----",
    "ghp_" + "A" * 36,
    "github_pat_" + "A" * 82,
    "AIza" + "A" * 35,
    "AIza" + "A" * 34 + "-",
    "GOCSPX-" + "A" * 28,
    "GOCSPX-" + "A" * 27 + "-",
])
def test_checks_credentials_without_custom_names(secret):
    assert check_no_pii.find_issues("first line\n" + secret, [])
    assert check_no_pii.find_issues("first line\n" + secret, [])[0][0] == 2


def test_checks_custom_names_without_logging_the_name():
    issues = check_no_pii.find_issues("SYNTHETIC private name", ["synthetic"])
    assert issues == [(1, "custom restricted term #1")]
    assert "synthetic" not in repr(issues)


def test_ordinary_examples_are_allowed():
    assert check_no_pii.find_issues("viewer@example.test, PLACEHOLDER_TOKEN, -5", []) == []


def test_main_runs_without_a_custom_list_and_hides_secrets(tmp_path, monkeypatch, capsys):
    sample = tmp_path / "sample.json"
    secret = "ghp_" + "B" * 36
    sample.write_text(secret, encoding="utf-8")
    monkeypatch.setattr(check_no_pii, "ROOT", tmp_path)
    monkeypatch.setattr(check_no_pii, "BLOCKLIST_FILE", tmp_path / "missing")
    monkeypatch.setattr(check_no_pii, "iter_files", lambda: iter([sample]))
    assert check_no_pii.main() == 1
    output = capsys.readouterr()
    assert secret not in output.out + output.err
    assert "sample.json:1: GitHub token" in output.err
    sample.write_text("synthetic example", encoding="utf-8")
    assert check_no_pii.main() == 0


def test_scans_public_files_but_not_ignored_local_secrets(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text(".env\n", encoding="utf-8")
    (tmp_path / ".env").write_text("private local settings", encoding="utf-8")
    (tmp_path / ".env.example").write_text("PLACEHOLDER", encoding="utf-8")
    (tmp_path / "synthetic.cjs").write_text("example", encoding="utf-8")
    monkeypatch.setattr(check_no_pii, "ROOT", tmp_path)
    assert {path.name for path in check_no_pii.iter_files()} == {".env.example", "synthetic.cjs"}


@pytest.mark.parametrize("suffix", [".pem", ".key"])
def test_scans_a_tracked_key_even_when_its_extension_is_ignored(
    suffix, tmp_path, monkeypatch, capsys,
):
    subprocess.run(["git", "init", "--quiet", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text("*.pem\n*.key\n", encoding="utf-8")
    tracked = tmp_path / f"synthetic{suffix}"
    secret = "-----BEGIN " + "PRIVATE KEY-----"
    tracked.write_text(secret + "\nsynthetic data only\n", encoding="utf-8")
    ignored = tmp_path / f"local-only{suffix}"
    ignored.write_text(secret, encoding="utf-8")
    subprocess.run(["git", "add", "--force", tracked.name], cwd=tmp_path, check=True)
    monkeypatch.setattr(check_no_pii, "ROOT", tmp_path)
    monkeypatch.setattr(check_no_pii, "BLOCKLIST_FILE", tmp_path / "missing")

    assert check_no_pii.main() == 1
    output = capsys.readouterr()
    assert f"{tracked.name}:1: private key" in output.err
    assert ignored.name not in output.err
    assert secret not in output.out + output.err
