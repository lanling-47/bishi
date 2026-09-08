@{
    # Use an absolute path here if codex.exe is not available on PATH.
    CodexCommand = "codex.exe"

    # Fast defaults for screenshot question answering.
    Model = "gpt-5.6-sol"
    ReasoningEffort = "low"
    TimeoutSeconds = 120

    # The background worker checks for phone-triggered screenshot requests at this interval.
    PollSeconds = 3
    Prompt = @"
Read the attached desktop screenshot and answer the user's likely question or problem in Chinese.
Be concise and practical. Mention uncertainty when the screenshot does not contain enough information.
Do not execute commands, make changes, or reveal secrets that may be visible in the screenshot.
"@

    # The collector sends directly to the protected website API.
    Delivery = @{
        Provider = "website"
        # Same Wi-Fi example: http://192.168.1.10:8787
        # Internet access requires your HTTPS reverse-proxy/tunnel URL.
        WebsiteUrl = "http://127.0.0.1:8787"
        # Must exactly match INGEST_TOKEN in website/.env. Use a random secret.
        IngestToken = "replace-with-a-long-random-ingest-token"
    }
}
