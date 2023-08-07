/**
 * This is an extension for three.js to optimize first-intersection raycasts.
 * It uses Object sorting to avoid raycasting objects in the background, and octrees to raycast through a mesh with a lot of triangles way faster.
 * 
 * /!\ The implementation of Group.get_bounding_sphere is simplified, the bounding sphere found will be larger than the real bounding sphere of the group!
 * 
 * This extension requires the line `export {checkGeometryIntersection};` to be added at the end of the file three.module.js to work.
 * 
 * (for the following examples, three.js will be imported as THREE, and this extension as RAYCAST)
 * To use this extension's optimisation, you must import it, and define your objects with it.
 * For example, `var my_mesh = new THREE.Mesh()` will become `var my_mesh = new RAYCAST.Mesh()`,
 * this is applicable to BufferGeometries, Meshes, Groups and Raycasters
 * 
 * To use the optimized raycast, call RAYCAST.Raycaster.intersect_first,
 * for every Mesh found, if its octree was defined it will use it, else it will fall back to the method used by three.js.
 * To generate the octree of a mesh, call Mesh.make_octree,
 * you can also call Scene or Group .make_octrees to generate all octrees of Meshes in their descendants.
 * It is recommended to save the octrees with the Meshes because building an octree can be really slow, even for a loading screen,
 * so you can get a json string to save by doing JSON.stringify(Mesh.octree), and to use it later you can call Mesh.set_octree and pass it the json string.
 * 
 * P.S. : using octrees ignores material because storing Mesh material groups was complicated.
 */

import { Vector3, Matrix4, Triangle, Box3, Sphere, BufferGeometry, Object3D, Mesh, MeshBasicMaterial, DoubleSide, Group, Scene, Raycaster, Ray, checkGeometryIntersection } from "./three.module.js";

const default_material = new MeshBasicMaterial();
default_material.side = DoubleSide;

const MAX_TRIS = 100000;

/**
 * @typedef {Object} Intersection
 * @property {Number} distance
 * @property {Vector3 | null} point
 * @property {Mesh | null} object
 * @property {Number | null} faceIndex
 */

/** @type {Intersection} */
function null_intersect(max_dist=Infinity) {
    return {distance: max_dist, point: null, object: null, faceIndex: null}
};

// Adding methods to BufferGeometry
//#region BufferGeometry

/** @returns {Box3} the bounding box */
BufferGeometry.prototype.get_bounding_box = function() {
    if (this.boundingBox == null) this.computeBoundingBox();
    return this.boundingBox;
}

/** @returns {Sphere} the bounding sphere */
BufferGeometry.prototype.get_bounding_sphere = function() {
    if (this.boundingSphere == null) this.computeBoundingSphere();
    return this.boundingSphere;
}
//#endregion

// Adding attributes and methods to Mesh
//#region Mesh

Mesh.bounding_box = null;
Mesh.bounding_sphere = null;
Mesh.octree = null;

/** @returns {Box3} the bounding box*/
Mesh.prototype.get_bounding_box = function() {
    if (this.bounding_box == null) {

        this.bounding_box = new Box3();
        this.bounding_box.copy(this.geometry.get_bounding_box());
        this.updateMatrixWorld(true);
        this.bounding_box.applyMatrix4(this.matrixWorld);
    }
    return this.bounding_box;
}

/** @returns {Sphere} the bounding sphere*/
Mesh.prototype.get_bounding_sphere = function() {
    if (this.bounding_sphere == null) {
        this.bounding_sphere = new Sphere();
        this.bounding_sphere.copy(this.geometry.get_bounding_sphere());
        this.bounding_sphere.applyMatrix4(this.matrixWorld);
    }
    return this.bounding_sphere;
}

/** @returns {OctreeNode} the octree generated */
Mesh.prototype.make_octree = function() {
    /** @type {OctreeNode} */
    this.octree = new OctreeNode();
    this.octree.build(this);
    return this.octree
}

/** @param {String} json_octree - the octree as a json string*/
Mesh.prototype.set_octree = function(json_octree) {
    if (json_octree === null) return;
    this.octree = Object.assign(new OctreeNode(), JSON.parse(json_octree));
    this.octree.assign();
}
//#endregion

// Adding attributes and methods to Group
//#region Group

Group.prototype.bounding_box = null;
Group.prototype.bounding_sphere = null;

/** @returns {Box3} the group bounding box */
Group.prototype.get_bounding_box = function() {
    if (this.bounding_box === null || this.bounding_box.isEmpty()) {
        this.bounding_box = new Box3().makeEmpty();

        for (let i = 0; i < this.children.length; i++) {
            let child = this.children[i];

            if (typeof child.get_bounding_box === 'function') {
                let child_box = child.get_bounding_box();
                if (this.bounding_box.isEmpty()) {
                    this.bounding_box.copy(child_box);
                }
                else {
                    this.bounding_box.union(child_box);
                }
            }
        }
    }
    return this.bounding_box;
}

/** @returns {Sphere} an **upper bound approximation** of the group bounding sphere */
Group.prototype.get_bounding_sphere = function() {
    if (this.bounding_sphere === null || this.bounding_sphere.isEmpty()) {
        this.bounding_sphere = new Sphere().makeEmpty();

        for (let i = 0; i < this.children.length; i++) {
            let child = this.children[i];

            if (typeof child.get_bounding_sphere === 'function') {
                let child_sphere = child.get_bounding_sphere();
                if (this.bounding_sphere.isEmpty()) {
                    this.bounding_sphere.copy(child_sphere);
                }
                else {
                    this.bounding_sphere.union(child_sphere);
                }
            }
        }
    }
    return this.bounding_sphere;
}

/** @returns {Group} this @param {Object3D} object */
Group.add = function(object) {
    this.prototype.add();   // equivalent to super.add()

    // Handling enlarging bounds
    if (this.bounding_box == null || this.bounding_box.isEmpty()) {
        this.get_bounding_box();
    }
    else if (typeof object.get_bounding_box === 'function') {
        this.bounding_box.union(object.get_bounding_box())
    }

    if (this.bounding_sphere == null || this.bounding_sphere.isEmpty()) {
        this.get_bounding_sphere();
    }
    else if (typeof object.get_bounding_sphere === 'function') {
        this.bounding_sphere.union(object.get_bounding_sphere())
    }

    return this;
}

/** @returns {Group} this @param {Object3D} object */
Group.remove = function(object) {
    this.prototype.remove(object);   // equivalent to super.add()

    // Handling resetting bounds to be computed again
    this.bounding_box = null;
    this.bounding_sphere = null;

    return this;
}

/** @returns {Group} this */
Group.clear = function() {
    this.prototype.clear();   // equivalent to super.add()

    // Handling resetting bounds to be computed again
    this.bounding_box = null;
    this.bounding_sphere = null;

    return this;
}
//#endregion

function make_octrees() {
    for (const child of this.children) {
        if (typeof(child.make_octrees === "function")) {
            child.make_octrees();
        }
        else if (child.isMesh & typeof(child.make_octree === "function")) {
            if (child.octree === null) child.make_octree()
        }
    }
}

/** Traverse the Group to build an octree for each Mesh descendant */
Group.prototype.make_octrees = make_octrees

/** Traverse the Scene to build an octree for each Mesh descendant */
Scene.prototype.make_octrees = make_octrees

// Class to hold ranges of triangle indices for efficient storage
//#region IndexRanges

class IndexRanges {
    constructor() {
        this.ranges = [];
        this.count = 0;
    }

    /**
     * /!\ This is based on the hypothesis that indices are added in ascending order /!\
     * @param {Number} index
     */
    add(index) {
        if (this.count == 0) {
            this.ranges.push({start: index, end: index});
            this.count = 1;
            return;
        }

        const last_range = this.ranges[this.ranges.length-1];

        if (index < last_range.start) {
            throw new Error("Indices were not added to index group in ascending order!");
        }

        if (index == last_range.end + 3) {
            last_range.end = index;
        }

        else {
            this.ranges.push({start: index, end: index});
        }
        
        this.count ++;
    }
}
//#endregion

// Making an octree as light as possible
//#region Octree

class OctreeNode {
    constructor() {
        this.box = new Box3();
        /** @type {Array<OctreeNode|OctreeLeaf>} */
        this.children = [];
    }

    /**Builds a full octree from a mesh.
     * This is also called on subtrees, hence idx_ranges and bounding_box,
     * since they are required to determine which node of the octree is being built.
     * These arguments are fetched from the mesh at the octree root.
     * @param {IndexRanges} idx_ranges
     * @param {Mesh} mesh
     * @param {Box3} bounding_box
     */
    build(mesh, idx_ranges = null, bounding_box = null, depth = 0) {
        //#region bounding_box
        /** @type {Box3} */
        this.box = new Box3();
        if (bounding_box !== null) {
            this.box = bounding_box;
        }
        else if (mesh !== undefined) {
            this.box = mesh.get_bounding_box();
        }
        else {
            console.log("No bounding box available to make Octree Node!");
            return;
        }
        //#endregion

        //#region idx_ranges
        if (idx_ranges === null && mesh !== undefined) {
            idx_ranges = get_indices(mesh);
        }
        else if (idx_ranges === null) {
            console.log("No triangle indices available to make Octree Node!");
            return;
        }
        //#endregion

        //#region children
        /** @type {Vector3} */
        const center = this.box.getCenter(new Vector3());

        // getting all 8 box corners, copy pasted from three.module.js Box3.applyMatrix4
        /** @type {Array<Vector3>} */
        const corners = Array(8);
        corners[ 0 ] = new Vector3( this.box.min.x, this.box.min.y, this.box.min.z ); // 000
        corners[ 1 ] = new Vector3( this.box.min.x, this.box.min.y, this.box.max.z ); // 001
        corners[ 2 ] = new Vector3( this.box.min.x, this.box.max.y, this.box.min.z ); // 010
        corners[ 3 ] = new Vector3( this.box.min.x, this.box.max.y, this.box.max.z ); // 011
        corners[ 4 ] = new Vector3( this.box.max.x, this.box.min.y, this.box.min.z ); // 100
        corners[ 5 ] = new Vector3( this.box.max.x, this.box.min.y, this.box.max.z ); // 101
        corners[ 6 ] = new Vector3( this.box.max.x, this.box.max.y, this.box.min.z ); // 110
        corners[ 7 ] = new Vector3( this.box.max.x, this.box.max.y, this.box.max.z ); // 111

        // Constructing all 8 children sub-boxes
        /** @type {Array<Box3>} */
        const sub_boxes = Array(8);
        for (let i = 0; i < 8; i++) {
            sub_boxes[i] = new Box3().setFromPoints([center, corners[i]]);
        }

        // Creating IndexRanges to store indices of children triangles
        /** @type {Array<IndexRanges>} */
        const sub_ranges = Array(8);
        for (let i = 0; i < 8; i++) {
            sub_ranges[i] = new IndexRanges();
        }

        // Populating children indices by intersecting triangles with boxes
        for (const idx_range of idx_ranges.ranges) {
            for (let index = idx_range.start; index <= idx_range.end; index += 3)
            {
                // Fetching a triangle each time is not slower than using a dictionary.
                const triangle = get_triangle(index, mesh);

                for (let i = 0; i < 8; i++) {

                    if (sub_boxes[i].intersectsTriangle(triangle)) {
                        sub_ranges[i].add(index);
                        in_child = true;
                    }

                }
                
                // Please note that a triangle can be in multiple sub-nodes (overlap).
            }
        }

        // Creating children from sub-boxes and their triangle indices
        /** @type {Array<OctreeNode | OctreeLeaf>} */
        const children = [];

        for (let i = 0; i < 8; i++) {
            let nb_tris = sub_ranges[i].count
            if (nb_tris > 0) {
                if (nb_tris < MAX_TRIS /*|| nb_tris * 2 < depth*/) {
                    // The condition for choosing a leaf can be changed 
                    let leaf = new OctreeLeaf();
                    leaf.build(sub_ranges[i], sub_boxes[i]);
                    children.push(leaf);
                }

                else {
                    let child = new OctreeNode();
                    child.build(mesh, sub_ranges[i], sub_boxes[i], depth + 1);
                    if (child.children.length == 0) {
                        throw new Error("empty child");
                    }
                    else {
                        children.push(child);
                    }
                }
            }
        }

        if (children.length == 1 && children[0].constructor.name == "OctreeNode") {
            // Shortens a branch with only one child
            this.box = children[0].box;
            this.children = children[0].children;
        }
        else {
            this.children = children;
        }
        //#endregion
    }

    /**Recursive raycast through a mesh's octree
     * @returns {Intersection}
     * @param {Mesh} mesh
     * @param {Raycaster} raycaster
     * @param {Ray} local_ray
     * @param {Number} max_dist
     */
    raycast_first(mesh, raycaster, local_ray, max_dist = Infinity) {
        const ray = raycaster.ray;

        // Getting the distance between each child node and the start of the ray...
        let node_dists = [];
        for (const child of this.children) {
            let dist = 0;   // distance is 0 if ray starts in node

            if (!child.box.containsPoint(ray.origin)) {
                let point = new Vector3();
                if (ray.intersectBox(child.box, point) === null)
                    continue;  // skip node if no intersection
                dist = ray.origin.distanceTo(point);
            }

            node_dists.push({
                node: child,
                distance: dist
            });
        }

        // ... in order to sort them.
        node_dists.sort(dist_comp);

        let intersect = null_intersect(max_dist);
        // Raycasting child nodes until they start further than the first intersection.
        for (const node_dist of node_dists) {
            if (node_dist.distance >= intersect.distance) break;

            let new_intersect = node_dist.node.raycast_first(mesh, raycaster, local_ray, max_dist);
            if (new_intersect.distance < intersect.distance) {
                intersect = new_intersect;
            }
        }
        return intersect;
    }

    /** Recursively assigns the correct prototype to each attribute after reading from json */
    assign() {
        this.box = Object.assign(new Box3(), this.box);
        for (let i = 0; i < this.children.length; i++) {
            if (this.children[i].children === undefined) {
                //leaf case
                this.children[i] = Object.assign(new OctreeLeaf(), this.children[i]);
            }
            else {
                this.children[i] = Object.assign(new OctreeNode(), this.children[i]);
            }
            this.children[i].assign();
        }
    }
}

class OctreeLeaf {
    constructor() {
        this.box = new Box3();
        this.indices = new IndexRanges();
    }

    /**Gives attributes to a leaf of an octree.
     * @param {IndexRanges} idx_ranges
     * @param {Box3} bounding_box
     */
    build(idx_ranges, bounding_box) {
        this.box = bounding_box;
        this.indices = idx_ranges;
    }

    /**Final raycast of an octree search.
     * It goes through every triangle index it has
     * and asks the given mesh for an intersection.
     * @returns {Intersection}
     * @param {Mesh} mesh
     * @param {Raycaster} raycaster
     * @param {Ray} local_ray
     * @param {Number} max_dist
     */
    raycast_first(mesh, raycaster, local_ray, max_dist = Infinity) {
        let intersection = null_intersect(max_dist);

        // Looping over every index.
        for (const range of this.indices.ranges) {
            for (let tri_id = range.start; tri_id <= range.end; tri_id += 3) {
                let new_inter = ray_intersect_triangle(mesh, tri_id, raycaster, local_ray);
                if (isFinite(new_inter.distance)) console.log(new_inter);
                if (new_inter.distance < intersection.distance) {
                    intersection = new_inter;
                }
            }
        }

        return intersection;
    }

    /** Assigns the correct prototypes to its attributes after reading from json */
    assign() {
        this.box = Object.assign(new Box3(), this.box);
        this.indices = Object.assign(new IndexRanges(), this.indices);
    }
}
//#endregion

// Functions to build the Octree
//#region Octree_utils

/**Get a triangle from an index and its mesh.
 * @returns {Triangle}
 * @param {Number} tri_id
 * @param {Mesh} mesh
 */
function get_triangle(tri_id, mesh) {
    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;

    // Converting indices if the mesh is indexed.
    let a, b, c;
    if (index !== null) {
        a = index.getX(tri_id);
        b = index.getX(tri_id+1);
        c = index.getX(tri_id+2);
    }
    else if (position !== null) {
        a = tri_id;
        b = tri_id+1;
        c = tri_id+2;
    }

    // Asking the mesh for its vertices from the indices.
    let pA = new Vector3(), pB = new Vector3(), pC = new Vector3();
    mesh.getVertexPosition(a, pA);
    mesh.getVertexPosition(b, pB);
    mesh.getVertexPosition(c, pC);

    // Getting the triangle in world coordinates.
    let matrix = mesh.matrixWorld;
    return new Triangle(pA.applyMatrix4(matrix), pB.applyMatrix4(matrix), pC.applyMatrix4(matrix))
}

/**Get all ranges of triangle indices of a mesh.
 * If  everything's right, it should be a single range
 * going from 0 to 3 times the number of triangles.
 * @returns {IndexRanges}
 * @param {Mesh} mesh
 */
function get_indices(mesh) {
    const groups = mesh.geometry.groups;
    const drawRange = mesh.geometry.drawRange;
    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;

    /** @type {Array<Number>} */
    let indices = [];

    let count = 0;
    if ( index !== null ) {
        count = index.count;
    }
    // We get the number of triangles directly from the number of vertices if there's no index.
    else if ( position !== undefined ) {
        count = position.count;
    }

    // Treating the case of a mesh with material groups.
    if (Array.isArray( mesh.material )) {

        for ( const group of groups ) {
            const start = Math.max( group.start, drawRange.start );
            const end = Math.min( count, Math.min( ( group.start + group.count ), ( drawRange.start + drawRange.count ) ) );

            for ( let j = start; j < end; j += 3 ) {
                indices.push(j);
            }
        }
    }

    else {
        const start = Math.max( 0, drawRange.start );
        const end = Math.min( count, ( drawRange.start + drawRange.count ) );

        for ( let j = start; j < end; j += 3 ) {
            indices.push(j);
        }
    }

    // Sorting indices to add them in an IndexRanges.
    indices.sort(((a, b) => a - b));
    let id_ranges = new IndexRanges();
    for (const id of indices) {
        id_ranges.add(id);
    }

    return id_ranges;
}
//#endregion

// Remaking a recursive raycast method optimized to only return the first intersection
//#region Raycast

/**Returns the first intersection between the raycaster and the given mesh.
 * This methods checks if it can use octrees, if not it fallbacks to mesh._computeIntersections.
 * @returns {Intersection}
 * @param {Mesh} mesh
 * @param {Number} max_dist
 */
Raycaster.prototype.intersect_first_in_mesh = function( mesh, max_dist = Infinity ) {

    // The local ray is required when calling checkGeometryIntersection on every triangle tested, so it's computed once here.
    let inverseWorld = new Matrix4().copy(mesh.matrixWorld).invert();
    let local_ray = new Ray().copy(this.ray).applyMatrix4(inverseWorld);

    if (mesh.octree === undefined || mesh.octree === null) {
        // console.log("no octree defined, falling back to default method")
        let intersects = [];
        mesh._computeIntersections(this, intersects, local_ray);
        intersects.sort(dist_comp);
        // We only keep the first intersection, but we can keep all its data.
        if (intersects.length == 0) {
            return null_intersect(max_dist);
        }
        return intersects[0];
    }

    else {
        // console.log("using octree")
        return mesh.octree.raycast_first(mesh, this, local_ray, max_dist);
    }
}

/**Recursive traversal of a Scene/Group to get the first intersection with a given ray
 * @returns {Intersection}
 * @param {Scene | Group | Mesh} object
 * @param {Number} max_dist
 */
Raycaster.prototype.intersect_first = function(object, max_dist = Infinity) {

    if ( object.isMesh ) return this.intersect_first_in_mesh(object, max_dist);

    /**@type {Intersection}*/
    let intersection = null_intersect(max_dist);

    // Only properly applies to Groups and Scenes,
    // if you notice another class that needs traversing, add it here.
    if ( ! (object.isGroup || object.isScene) ) return intersection;

    /**@type {Array<{object: Mesh | Group, distance: Number}>}*/
    let dist_objs = [];

    // Getting the distance between each child and the ray origin
    for (const child of object.children) {

        if ( !(child.isMesh || child.isGroup) ) continue;

        let dist = dist_to_bounds( child, this.ray );

        if (!isFinite(dist) /*&& dist > 0*/) continue;	// not intersecting

        dist_objs.push({
            object: child,
            distance: dist
        });
    }

    dist_objs.sort( dist_comp );

    //intersecting objects until they are further away than the first intersection.
    for (const dist_obj of dist_objs) {

        if (dist_obj.distance >= intersection.distance) {
            return intersection;
        }

        /**@type {Intersection}*/
        let new_inter;
        let obj = dist_obj.object;
        if (obj.isGroup) {
            new_inter = this.intersect_first(obj, intersection.distance);
        }
        else {
            new_inter = this.intersect_first_in_mesh(obj, intersection.distance);
        }

        if (new_inter.distance < intersection.distance) {
            intersection = new_inter;
        }
    }

    return intersection;
}

//#endregion

// Functions to raycast
//#region Raycaster_utils

/**Computes the distance between the origin of the given ray and one of the bounding shapes of the object
 * (further is better because closer to the actual geometry).
 * @returns {Number}
 * @param {Mesh | Group} object
 * @param {Ray} ray
 */
function dist_to_bounds( object, ray ) {
	// Only classes with get_bounding_XXX implemented are supported
	if (
        typeof(object.get_bounding_box) != "function" ||
        typeof(object.get_bounding_sphere) != "function"
    ) return -Infinity;

	const box = object.get_bounding_box();
	const sphere = object.get_bounding_sphere();
	const origin = ray.origin;

	let box_dist = 0, sphere_dist = 0;

    // Distance to bounding box
	if (box.containsPoint(origin)) {
		box_dist = -1;
	}
	else {
		let box_inter = new Vector3();
		if (ray.intersectBox(box, box_inter) == null) box_dist = Infinity;
		else box_dist = origin.distanceTo(box_inter);
	}

    // Distance to bounding sphere
	if (sphere.containsPoint(origin)) {
		sphere_dist = -1;
	}
	else {
		let sphere_inter = new Vector3();
		if (ray.intersectSphere(sphere, sphere_inter) == null) sphere_dist = Infinity;
		else sphere_dist = origin.distanceTo(sphere_dist);
	}

	// Infinite dist <=> not intersecting
	if (!isFinite(box_dist) && !isFinite(sphere_dist)) return Infinity;
	if (!isFinite(box_dist)) return sphere_dist;
	if (!isFinite(sphere_dist)) return box_dist;

	// dist == -1 <=> contained
	if (box_dist < 0 && sphere_dist < 0) return -1;
	if (box_dist < 0) return sphere_dist;
	if (sphere_dist < 0) return box_dist;

    // The distance to the furthest bounding shape is taken because it's closer to the actual model.

	return Math.max(box_dist, sphere_dist);
}

/** Compares the distance of 2 objects */
function dist_comp( a, b ) {

	return a.distance - b.distance;

}

/**Computes the intersection between a ray and a triangle.
 * The triangle is given by its mesh and its index in the mesh.
 * If there's no intersection, returns {distance: Infinity, point: null, object: null, ...}.
 * @param {Mesh} mesh
 * @param {Number} tri_id
 * @param {Raycaster} raycaster
 * @param {Ray} local_ray
 * @returns {Intersection}
 */
function ray_intersect_triangle(mesh, tri_id, raycaster, local_ray) {

    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;

    const normal = mesh.geometry.attributes.normal;
    const uv = mesh.geometry.attributes.uv;
    const uv1 = mesh.geometry.attributes.uv1;

    let a, b, c;

    // Converting indices if the mesh uses indexing.
    if ( index !== null ) {
        a = index.getX( tri_id );
        b = index.getX( tri_id + 1 );
        c = index.getX( tri_id + 2 );
    }
    else if ( position !== undefined ) {
        a = tri_id;
        b = tri_id + 1;
        c = tri_id + 2;
    }
    else return null_intersect();

    // Calling a three.js function handling material, uv and normal coordinates.
    // It is necessary that three.js exports it.
    let intersection = checkGeometryIntersection( mesh, default_material, raycaster, local_ray, uv, uv1, normal, a, b, c );

    if ( intersection ) {
        intersection.faceIndex = Math.floor( tri_id / 3 );
        // triangle number in non-indexed buffer semantics
        return intersection;
    }

    else return null_intersect();
}
//#endregion

export { Scene, Group, Mesh, BufferGeometry, Raycaster, OctreeNode }