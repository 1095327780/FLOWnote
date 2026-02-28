#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0

skill_dirs=()
while IFS= read -r d; do
  skill_dirs+=("$d")
done < <(find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

echo "Lint target: $ROOT_DIR"

check_frontmatter() {
  local file="$1"

  if ! head -n 1 "$file" | grep -q '^---$'; then
    echo "ERROR: missing frontmatter start -> $file"
    FAIL=1
    return
  fi

  local fm
  fm=$(awk 'NR==1&&$0=="---"{flag=1;next} flag&&$0=="---"{exit} flag{print}' "$file")

  if [[ -z "$fm" ]]; then
    echo "ERROR: empty frontmatter -> $file"
    FAIL=1
    return
  fi

  local keys
  keys=$(printf "%s\n" "$fm" | rg -o '^[a-zA-Z][a-zA-Z_-]*:' | sed 's/:$//' | sort -u || true)

  if ! printf "%s\n" "$keys" | rg -q '^name$'; then
    echo "ERROR: frontmatter missing name -> $file"
    FAIL=1
  fi

  if ! printf "%s\n" "$keys" | rg -q '^description$'; then
    echo "ERROR: frontmatter missing description -> $file"
    FAIL=1
  fi

  local extra
  extra=$(printf "%s\n" "$keys" | rg -v '^(name|description)$' || true)
  if [[ -n "$extra" ]]; then
    echo "ERROR: frontmatter has extra keys [$extra] -> $file"
    FAIL=1
  fi
}

check_contract() {
  local file="$1"
  local headings=(
    '^## Skill Contract$'
    '^### Inputs$'
    '^### Reads$'
    '^### Writes$'
    '^### Calls$'
    '^### Return$'
    '^### Failure Handling$'
  )

  for h in "${headings[@]}"; do
    if ! rg -q "$h" "$file"; then
      echo "ERROR: missing heading $h -> $file"
      FAIL=1
    fi
  done
}

check_paths() {
  local file="$1"
  if rg -n 'skills/ah-|\.opencode/|\.agents/skills/ah/' "$file" >/dev/null; then
    echo "ERROR: forbidden path pattern -> $file"
    rg -n 'skills/ah-|\.opencode/|\.agents/skills/ah/' "$file" || true
    FAIL=1
  fi
}

check_line_budget() {
  local file="$1"
  local skill
  skill=$(basename "$(dirname "$file")")
  local lines
  lines=$(wc -l < "$file" | tr -d ' ')
  local max=280

  if [[ "$skill" == "ah-memory" ]]; then
    max=180
  elif [[ "$skill" == "ah" ]]; then
    max=220
  fi

  if (( lines > max )); then
    echo "ERROR: line budget exceeded ($lines > $max) -> $file"
    FAIL=1
  fi
}

check_resources_referenced() {
  local skill_dir="$1"
  local skill_file="$skill_dir/SKILL.md"

  while IFS= read -r res; do
    local base
    base=$(basename "$res")

    if ! rg -q "${base//./\\.}|assets/${base//./\\.}|references/${base//./\\.}" "$skill_file"; then
      echo "ERROR: unreferenced resource -> $res"
      FAIL=1
    fi
  done < <(find "$skill_dir" -type f \( -path '*/assets/*' -o -path '*/references/*' \) | sort)
}

check_agents_yaml() {
  local skill_dir="$1"
  local file="$skill_dir/agents/openai.yaml"
  if [[ ! -f "$file" ]]; then
    echo "ERROR: missing agents/openai.yaml -> $skill_dir"
    FAIL=1
  fi
}

for dir in "${skill_dirs[@]}"; do
  skill_file="$dir/SKILL.md"

  if [[ ! -f "$skill_file" ]]; then
    continue
  fi

  check_frontmatter "$skill_file"
  check_contract "$skill_file"
  check_paths "$skill_file"
  check_line_budget "$skill_file"
  check_resources_referenced "$dir"
  check_agents_yaml "$dir"

done

if (( FAIL > 0 )); then
  echo "\nLint FAILED"
  exit 1
fi

echo "\nLint PASSED"
