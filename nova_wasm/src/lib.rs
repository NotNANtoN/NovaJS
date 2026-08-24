use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Point {
    x: f32,
    y: f32,
}

fn cross(origin: Point, a: Point, b: Point) -> f64 {
    let ax = f64::from(a.x - origin.x);
    let ay = f64::from(a.y - origin.y);
    let bx = f64::from(b.x - origin.x);
    let by = f64::from(b.y - origin.y);
    ax * by - ay * bx
}

fn convex_hull_points(points: &[Point]) -> Vec<Point> {
    let mut sorted = points
        .iter()
        .copied()
        .filter(|point| point.x.is_finite() && point.y.is_finite())
        .collect::<Vec<_>>();
    sorted.sort_by(|a, b| {
        a.x.total_cmp(&b.x)
            .then_with(|| a.y.total_cmp(&b.y))
    });
    sorted.dedup();

    if sorted.len() <= 1 {
        return sorted;
    }

    let mut lower = Vec::with_capacity(sorted.len());
    for point in sorted.iter().copied() {
        while lower.len() >= 2
            && cross(lower[lower.len() - 2], lower[lower.len() - 1], point) <= 0.0
        {
            lower.pop();
        }
        lower.push(point);
    }

    let mut upper = Vec::with_capacity(sorted.len());
    for point in sorted.iter().rev().copied() {
        while upper.len() >= 2
            && cross(upper[upper.len() - 2], upper[upper.len() - 1], point) <= 0.0
        {
            upper.pop();
        }
        upper.push(point);
    }

    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

fn flatten_points(points: &[Point]) -> Vec<f32> {
    let mut output = Vec::with_capacity(points.len() * 2);
    for point in points {
        output.push(point.x);
        output.push(point.y);
    }
    output
}

/// Computes a convex hull from an x/y pair array.
///
/// The returned vertices are not repeated at the end. Collinear points inside
/// an edge are omitted, while one- and two-point inputs are preserved.
#[wasm_bindgen]
pub fn convex_hull(points: &[f32]) -> Vec<f32> {
    let points = points
        .chunks_exact(2)
        .map(|pair| Point {
            x: pair[0],
            y: pair[1],
        })
        .collect::<Vec<_>>();
    flatten_points(&convex_hull_points(&points))
}

fn pixel_is_visible(rgba: &[u8], width: usize, height: usize, x: usize, y: usize, threshold: u8) -> bool {
    if x >= width || y >= height {
        return false;
    }
    let index = (y * width + x) * 4 + 3;
    index < rgba.len() && rgba[index] >= threshold
}

/// Computes a convex hull directly from an RGBA image.
///
/// Pixels with alpha greater than or equal to `alpha_threshold` are included.
/// Only visible pixels on the four-neighbour boundary are passed to the hull
/// algorithm. Coordinates are returned in image space, with (0, 0) at the
/// upper-left corner.
#[wasm_bindgen]
pub fn convex_hull_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    alpha_threshold: u8,
) -> Vec<f32> {
    let width = width as usize;
    let height = height as usize;
    let expected_len = width.checked_mul(height).and_then(|size| size.checked_mul(4));
    if expected_len.is_none() || rgba.len() < expected_len.unwrap_or(usize::MAX) {
        return Vec::new();
    }

    let mut boundary = Vec::new();
    for y in 0..height {
        for x in 0..width {
            if !pixel_is_visible(rgba, width, height, x, y, alpha_threshold) {
                continue;
            }

            let is_boundary = x == 0
                || y == 0
                || x + 1 == width
                || y + 1 == height
                || !pixel_is_visible(rgba, width, height, x - 1, y, alpha_threshold)
                || !pixel_is_visible(rgba, width, height, x + 1, y, alpha_threshold)
                || !pixel_is_visible(rgba, width, height, x, y - 1, alpha_threshold)
                || !pixel_is_visible(rgba, width, height, x, y + 1, alpha_threshold);
            if is_boundary {
                boundary.push(Point {
                    x: x as f32,
                    y: y as f32,
                });
            }
        }
    }

    flatten_points(&convex_hull_points(&boundary))
}

fn polygon_slice<'a>(vertices: &'a [f32], offsets: &[u32], index: usize) -> Option<&'a [f32]> {
    let start = *offsets.get(index)? as usize;
    let end = *offsets.get(index + 1)? as usize;
    if start > end || end > vertices.len() || (end - start) % 2 != 0 {
        return None;
    }
    Some(&vertices[start..end])
}

fn transformed_polygon(vertices: &[f32], position: Point, angle: f32) -> Vec<Point> {
    let sin = angle.sin();
    let cos = angle.cos();
    vertices
        .chunks_exact(2)
        .map(|pair| Point {
            x: cos * pair[0] - sin * pair[1] + position.x,
            y: sin * pair[0] + cos * pair[1] + position.y,
        })
        .collect()
}

fn project(polygon: &[Point], axis: Point) -> (f64, f64) {
    let first = f64::from(polygon[0].x) * f64::from(axis.x)
        + f64::from(polygon[0].y) * f64::from(axis.y);
    polygon.iter().skip(1).fold((first, first), |(min, max), point| {
        let projection = f64::from(point.x) * f64::from(axis.x)
            + f64::from(point.y) * f64::from(axis.y);
        (min.min(projection), max.max(projection))
    })
}

fn has_separating_axis(axis_start: Point, axis_end: Point, a: &[Point], b: &[Point]) -> bool {
    let axis = Point {
        x: -(axis_end.y - axis_start.y),
        y: axis_end.x - axis_start.x,
    };
    if axis.x == 0.0 && axis.y == 0.0 {
        return false;
    }
    let (a_min, a_max) = project(a, axis);
    let (b_min, b_max) = project(b, axis);
    a_max < b_min || b_max < a_min
}

fn polygons_collide(a: &[Point], b: &[Point]) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }

    for polygon in [a, b] {
        for index in 0..polygon.len() {
            let next = (index + 1) % polygon.len();
            if has_separating_axis(polygon[index], polygon[next], a, b) {
                return false;
            }
        }
    }
    true
}

fn polygon_position(positions: &[f32], index: usize) -> Option<Point> {
    Some(Point {
        x: *positions.get(index.checked_mul(2)?)?,
        y: *positions.get(index.checked_mul(2)?.checked_add(1)?)?,
    })
}

/// Tests candidate pairs of convex polygons with the separating axis theorem.
///
/// Each offset is an index into the corresponding flattened vertex array, and
/// each polygon therefore occupies `vertices[offsets[i]..offsets[i + 1]]`.
/// Positions contain x/y pairs, rotations contain radians, and pairs contain
/// polygon-index pairs. The result contains one byte per candidate (0 or 1).
#[wasm_bindgen]
pub fn sat_batch(
    a_vertices: &[f32],
    a_offsets: &[u32],
    a_positions: &[f32],
    a_rotations: &[f32],
    b_vertices: &[f32],
    b_offsets: &[u32],
    b_positions: &[f32],
    b_rotations: &[f32],
    pairs: &[u32],
) -> Vec<u8> {
    let mut result = Vec::with_capacity(pairs.len() / 2);
    for pair in pairs.chunks_exact(2) {
        let a_index = pair[0] as usize;
        let b_index = pair[1] as usize;
        let collision = match (
            polygon_slice(a_vertices, a_offsets, a_index),
            polygon_slice(b_vertices, b_offsets, b_index),
            polygon_position(a_positions, a_index),
            polygon_position(b_positions, b_index),
            a_rotations.get(a_index),
            b_rotations.get(b_index),
        ) {
            (Some(a), Some(b), Some(a_position), Some(b_position), Some(&a_angle), Some(&b_angle)) => {
                let a = transformed_polygon(a, a_position, a_angle);
                let b = transformed_polygon(b, b_position, b_angle);
                polygons_collide(&a, &b)
            }
            _ => false,
        };
        result.push(u8::from(collision));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f32, y: f32, size: f32) -> Vec<f32> {
        vec![
            x, y,
            x + size, y,
            x + size, y + size,
            x, y + size,
        ]
    }

    #[test]
    fn convex_hull_removes_interior_and_collinear_points() {
        let points = vec![
            1.0, 1.0,
            0.0, 0.0,
            2.0, 0.0,
            2.0, 2.0,
            0.0, 2.0,
            1.0, 0.0,
            1.0, 1.0,
        ];
        assert_eq!(
            convex_hull(&points),
            vec![0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0]
        );
    }

    #[test]
    fn rgba_hull_uses_visible_boundary_pixels() {
        let mut rgba = vec![0; 3 * 3 * 4];
        for y in 0..3 {
            for x in 0..3 {
                let index = (y * 3 + x) * 4 + 3;
                rgba[index] = 255;
            }
        }
        assert_eq!(
            convex_hull_rgba(&rgba, 3, 3, 255),
            vec![0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 2.0]
        );
    }

    #[test]
    fn rgba_hull_honors_alpha_threshold() {
        let mut rgba = vec![0; 2 * 4];
        rgba[3] = 100;
        rgba[7] = 200;
        assert_eq!(convex_hull_rgba(&rgba, 2, 1, 150), vec![1.0, 0.0]);
    }

    #[test]
    fn sat_batch_reports_collisions_and_separations() {
        let a = square(-1.0, -1.0, 2.0);
        let b = square(-1.0, -1.0, 2.0);
        let offsets = vec![0, 8];
        let positions = vec![0.0, 0.0];
        let rotations = vec![0.0];
        let pairs = vec![0, 0];
        assert_eq!(
            sat_batch(
                &a,
                &offsets,
                &positions,
                &rotations,
                &b,
                &offsets,
                &positions,
                &rotations,
                &pairs,
            ),
            vec![1]
        );

        let separated_positions = vec![3.0, 0.0];
        assert_eq!(
            sat_batch(
                &a,
                &offsets,
                &positions,
                &rotations,
                &b,
                &offsets,
                &separated_positions,
                &rotations,
                &pairs,
            ),
            vec![0]
        );
    }

    #[test]
    fn sat_batch_returns_one_result_per_candidate_pair() {
        let a = [
            -1.0, -1.0,
            1.0, -1.0,
            1.0, 1.0,
            -1.0, 1.0,
            9.0, -1.0,
            11.0, -1.0,
            11.0, 1.0,
            9.0, 1.0,
        ];
        let b = square(-1.0, -1.0, 2.0);
        let a_offsets = vec![0, 8, 16];
        let b_offsets = vec![0, 8];
        let a_positions = vec![0.0, 0.0, 0.0, 0.0];
        let b_positions = vec![0.0, 0.0];
        let rotations = vec![0.0, 0.0];
        let pairs = vec![0, 0, 1, 0];

        assert_eq!(
            sat_batch(
                &a,
                &a_offsets,
                &a_positions,
                &rotations,
                &b,
                &b_offsets,
                &b_positions,
                &vec![0.0],
                &pairs,
            ),
            vec![1, 0]
        );
    }

    #[test]
    fn sat_batch_applies_rotation_to_local_vertices() {
        let a = vec![
            -2.0, -0.25,
            2.0, -0.25,
            2.0, 0.25,
            -2.0, 0.25,
        ];
        let b = a.clone();
        let offsets = vec![0, 8];
        let positions = vec![0.0, 0.0];
        let b_positions = vec![0.0, 1.5];
        let pairs = vec![0, 0];
        assert_eq!(
            sat_batch(
                &a,
                &offsets,
                &positions,
                &vec![0.0],
                &b,
                &offsets,
                &b_positions,
                &vec![0.0],
                &pairs,
            ),
            vec![0]
        );
        assert_eq!(
            sat_batch(
                &a,
                &offsets,
                &positions,
                &vec![0.0],
                &b,
                &offsets,
                &b_positions,
                &vec![std::f32::consts::FRAC_PI_2],
                &pairs,
            ),
            vec![1]
        );
    }
}
