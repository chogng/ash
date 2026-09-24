use super::fit_column_widths;

#[test]
fn column_widths_fill_the_available_table_width() {
    let widths = fit_column_widths(&[80.0, 120.0, 60.0], 420.0);

    assert!((widths.iter().sum::<f32>() - 420.0).abs() < 0.001);
    assert!(widths[1] > widths[0]);
    assert!(widths[0] > widths[2]);
}

#[test]
fn narrow_tables_keep_every_column_represented() {
    let widths = fit_column_widths(&[300.0, 100.0], 70.0);

    assert_eq!(widths, vec![35.0, 35.0]);
}
