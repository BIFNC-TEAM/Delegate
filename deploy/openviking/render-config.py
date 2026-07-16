import os
from pathlib import Path
from string import Template


def main() -> None:
    template_path = Path("/opt/delegate-openviking/ov.conf.example")
    output_path = Path("/etc/openviking/ov.conf")
    provider = os.getenv("OPENVIKING_PROVIDER", "openai").strip() or "openai"
    dedicated_api_key = os.getenv("OPENVIKING_MODEL_API_KEY", "").strip()
    dedicated_api_base = os.getenv("OPENVIKING_MODEL_API_BASE", "").strip()

    if provider == "volcengine":
        model_api_key = dedicated_api_key or os.getenv("ARK_API_KEY", "")
        model_api_base = dedicated_api_base or os.getenv(
            "ARK_API_BASE",
            "https://ark.cn-beijing.volces.com/api/v3",
        )
    else:
        model_api_key = dedicated_api_key or os.getenv("OPENAI_API_KEY", "")
        model_api_base = dedicated_api_base or os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")

    if not model_api_key:
        model_api_key = "delegate-openviking-placeholder-key"

    root_api_key = os.getenv("OPENVIKING_ROOT_API_KEY", "").strip()

    values = {
        "OPENVIKING_ROOT_API_KEY_JSON": f'"{root_api_key}"' if root_api_key else "null",
        "OPENVIKING_PROVIDER": provider,
        "OPENVIKING_VLM_MODEL": os.getenv("OPENVIKING_VLM_MODEL", "gpt-4o-mini"),
        "OPENVIKING_EMBEDDING_MODEL": os.getenv(
            "OPENVIKING_EMBEDDING_MODEL",
            "text-embedding-3-large",
        ),
        "OPENVIKING_EMBEDDING_DIMENSION": os.getenv("OPENVIKING_EMBEDDING_DIMENSION", "3072"),
        "MODEL_API_KEY": model_api_key,
        "MODEL_API_BASE": model_api_base,
    }

    rendered = Template(template_path.read_text(encoding="utf-8")).safe_substitute(values)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
