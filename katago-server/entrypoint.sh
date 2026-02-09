#!/usr/bin/env bash
set -euo pipefail

KATAGO_ROOT="/opt/katago"
BIN_DIR="${KATAGO_ROOT}/bin"
CFG_DIR="${KATAGO_ROOT}/config"
MODEL_DIR="${KATAGO_ROOT}/models"

KATAGO_VERSION="${KATAGO_VERSION:-v1.16.4}"
KATAGO_TARGET="${KATAGO_TARGET:-eigen-linux-x64}"
KATAGO_BIN="${BIN_DIR}/katago"
KATAGO_CFG="${CFG_DIR}/gtp.cfg"
KATAGO_MODEL="${MODEL_DIR}/model.bin.gz"

mkdir -p "${BIN_DIR}" "${CFG_DIR}" "${MODEL_DIR}"

download_katago() {
  local archive="/tmp/katago.zip"
  local unpack_dir="/tmp/katago"
  local asset="katago-${KATAGO_VERSION}-${KATAGO_TARGET}.zip"
  local url="https://github.com/lightvector/KataGo/releases/download/${KATAGO_VERSION}/${asset}"

  echo "Downloading KataGo ${KATAGO_VERSION} (${KATAGO_TARGET})..."
  curl -fsSL "${url}" -o "${archive}"
  rm -rf "${unpack_dir}"
  mkdir -p "${unpack_dir}"
  unzip -q "${archive}" -d "${unpack_dir}"

  local found_bin
  found_bin="$(find "${unpack_dir}" -type f -name katago | head -n 1)"
  if [[ -z "${found_bin}" ]]; then
    echo "KataGo binary was not found in archive"
    exit 1
  fi
  install -m 0755 "${found_bin}" "${KATAGO_BIN}"

  local found_cfg
  found_cfg="$(find "${unpack_dir}" -type f -name gtp_example.cfg | head -n 1 || true)"
  if [[ -n "${found_cfg}" ]]; then
    cp "${found_cfg}" "${KATAGO_CFG}"
  fi
}

ensure_cfg() {
  if [[ -f "${KATAGO_CFG}" ]]; then
    return
  fi
  echo "gtp.cfg is missing; downloading default config from KataGo repository"
  curl -fsSL "https://raw.githubusercontent.com/lightvector/KataGo/${KATAGO_VERSION}/cpp/configs/gtp_example.cfg" -o "${KATAGO_CFG}"
}

download_model() {
  local model_url="${KATAGO_MODEL_URL:-}"
  if [[ -z "${model_url}" ]]; then
    echo "KATAGO_MODEL_URL is empty, trying latest model from katagotraining.org"
    local page="/tmp/katago-networks.html"
    curl -fsSL https://katagotraining.org/networks/ -o "${page}"
    local href
    href="$(grep -oE 'href="[^"]+\.bin\.gz"' "${page}" | sed -n '1p' | cut -d '"' -f 2 || true)"
    if [[ -z "${href}" ]]; then
      echo "Could not find a model URL automatically. Set KATAGO_MODEL_URL in docker-compose.yml"
      exit 1
    fi
    if [[ "${href}" =~ ^https?:// ]]; then
      model_url="${href}"
    else
      model_url="https://katagotraining.org${href}"
    fi
  fi

  echo "Downloading model: ${model_url}"
  curl -fsSL "${model_url}" -o "${KATAGO_MODEL}"
}

if [[ ! -x "${KATAGO_BIN}" ]]; then
  download_katago
fi

if [[ ! -f "${KATAGO_CFG}" ]]; then
  echo "gtp.cfg is missing; re-downloading KataGo package for default config"
  download_katago
fi

ensure_cfg

if [[ ! -f "${KATAGO_MODEL}" ]]; then
  download_model
fi

export KATAGO_GTP_CMD="/opt/katago/bin/katago gtp -config /opt/katago/config/gtp.cfg -model /opt/katago/models/model.bin.gz"
# KataGo Linux builds are often distributed as AppImage.
# In containers there is usually no FUSE, so run AppImage in extract mode.
export APPIMAGE_EXTRACT_AND_RUN=1

exec uvicorn app:app --host "${KATAGO_API_HOST:-0.0.0.0}" --port "${KATAGO_API_PORT:-8080}"
