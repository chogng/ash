fn main() {
    println!("cargo:rerun-if-changed=src");
    cc::Build::new().include("src").file("src/parser.c").warnings(false).compile("tree-sitter-clojure");
}
