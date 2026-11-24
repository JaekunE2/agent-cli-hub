use super::*;

#[test]
fn token_prefers_file_and_only_accepts_the_selected_loopback_url() {
    let dir = env::temp_dir().join(format!("agent-cli-hub-token-test-{}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let secret = dir.join(".token");
    let url_file = dir.join("url.txt");
    let base = Url::parse("http://127.0.0.1:7777/").unwrap();
    let fallback_url = "http://127.0.0.1:7777/?t=fixture%26value";
    fs::write(&url_file, fallback_url).unwrap();
    fs::write(&secret, "file-fixture\r\n").unwrap();
    assert_eq!(token(&dir, &base).as_deref(), Some("file-fixture"));
    fs::remove_file(&secret).unwrap();
    assert_eq!(token(&dir, &base).as_deref(), Some("fixture&value"));
    for invalid in [
        "http://127.0.0.1:8888/?t=other-port",
        "http://example.invalid:7777/?t=other-origin",
        "http://127.0.0.1:7777/another-path?t=other-path",
    ] {
        fs::write(&url_file, invalid).unwrap();
        assert!(token(&dir, &base).is_none());
    }
    fs::remove_file(&url_file).unwrap();
    fs::remove_dir(&dir).unwrap();
}
