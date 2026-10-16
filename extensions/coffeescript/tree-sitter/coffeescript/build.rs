fn main() {
    println!("cargo:rerun-if-changed=src");
    cc::Build::new().include("src").file("src/parser.c").file("src/scanner.c").warnings(false).compile("tree-sitter-coffeescript");
}
