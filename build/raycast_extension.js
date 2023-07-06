import { Vector3, Matrix4, Triangle, Box3, Sphere, BufferGeometry, Object3D, Mesh, MeshBasicMaterial, DoubleSide, Group, Scene, Raycaster, Ray, checkGeometryIntersection } from "./three.module.js";

const default_material = new MeshBasicMaterial(DoubleSide)

const MAX_TRIS = 100000;

// Adding methods to BufferGeometry
//#region BufferGeometry

/**
 * @returns {Box3}
 */
BufferGeometry.prototype.get_bounding_box = function() {
    if (this.boundingBox == null) this.computeBoundingBox();
    return this.boundingBox;
}

/**
 * @returns {Box3}
 */
BufferGeometry.prototype.get_bounding_sphere = function() {
    if (this.boundingSphere == null) this.computeBoundingSphere();
    return this.boundingSphere;
}
//#endregion

// Adding attributes and methods to Mesh
//#region Mesh

Mesh.prototype.bounding_box = null;
Mesh.prototype.bounding_sphere = null;
Mesh.prototype.octree = null;

/**
 * @returns {Box3}
 */
Mesh.prototype.get_bounding_box = function() {
    if (this.bounding_box == null) {
        
        this.bounding_box = new Box3();
        this.bounding_box.copy(this.geometry.get_bounding_box());
        this.updateMatrixWorld(true);
        this.bounding_box.applyMatrix4(this.matrixWorld);
    }
    return this.bounding_box;
}

/**
 * @returns {Sphere}
 */
Mesh.prototype.get_bounding_sphere = function() {
    if (this.bounding_sphere == null) {
        this.bounding_sphere = new Sphere();
        this.bounding_sphere.copy(this.geometry.get_bounding_sphere());
        this.bounding_sphere.applyMatrix4(this.matrixWorld);
    }
    return this.bounding_sphere;
}

Mesh.prototype.make_octree = function() {
    /** @type {OctreeNode} */
    this.octree = new OctreeNode(this);
    
    var a = document.createElement("a");
    var file = new Blob([JSON.stringify(this.octree/*, undefined, 2*/)], {type: "application/json"});
    a.href = URL.createObjectURL(file);
    a.download = this.name + "_octree.json";
    a.click();
    URL.revokeObjectURL(a.href);
}
//#endregion

// Adding attributes and methods to Group
//#region Group

Group.prototype.bounding_box = null;
Group.prototype.bounding_sphere = null;

/**
 * @returns {Box3}
 */
Group.prototype.get_bounding_box = function() {
    if (this.bounding_box == null) {
        this.bounding_box = new Box3().makeEmpty();

        for (let i = 0; i < this.children.length; i++) {
            let child = this.children[i];

            if (typeof child.get_bounding_box === 'function') {
                this.bounding_box.union(child.get_bounding_box());
            }
        }
    }
    return this.bounding_box;
}

/**
 * @returns {Sphere}
 */
Group.prototype.get_bounding_sphere = function() {
    if (this.bounding_sphere == null) {
        this.bounding_sphere = new Sphere().makeEmpty();

        for (let i = 0; i < this.children.length; i++) {
            let child = this.children[i];

            if (typeof child.get_bounding_sphere === 'function') {
                this.bounding_sphere.union(child.get_bounding_sphere());
            }
        }
    }
    return this.bounding_sphere;
}

const _addedEvent = { type: 'added' };
const _removedEvent = { type: 'removed' };

/**
 * @param {Object3D} object 
 */
Group.prototype.add = function(object) {
    // Copy pasted from three.module.js Object3D.add
    //#region Object3D.add
    if ( arguments.length > 1 ) {

        for ( let i = 0; i < arguments.length; i ++ ) {

            this.add( arguments[ i ] );

        }

        return this;

    }

    if ( object === this ) {

        console.error( 'THREE.Object3D.add: object can\'t be added as a child of itself.', object );
        return this;

    }

    if ( object && object.isObject3D ) {

        if ( object.parent !== null ) {

            object.parent.remove( object );

        }

        object.parent = this;
        this.children.push( object );

        object.dispatchEvent( _addedEvent );

    } else {

        console.error( 'THREE.Object3D.add: object not an instance of THREE.Object3D.', object );

    }
    //#endregion

    // Handling enlarging bounds
    if (this.bounding_box == null) {
        this.get_bounding_box();
    }
    else if (typeof object.get_bounding_box === 'function') {
        this.bounding_box.union(object.get_bounding_box())
    }
    
    if (this.bounding_sphere == null) {
        this.get_bounding_sphere();
    }
    else if (typeof object.get_bounding_sphere === 'function') {
        this.bounding_sphere.union(object.get_bounding_sphere())
    }

    return this;
}

/**
 * @param {Object3D} object
 */
Group.prototype.remove = function(object) {
    // Copy pasted from three.module.js Object3D.remove
    //#region Object3D.remove
    if ( arguments.length > 1 ) {

        for ( let i = 0; i < arguments.length; i ++ ) {

            this.remove( arguments[ i ] );

        }

        return this;

    }

    const index = this.children.indexOf( object );

    if ( index !== - 1 ) {

        object.parent = null;
        this.children.splice( index, 1 );

        object.dispatchEvent( _removedEvent );

    }
    //#endregion

    // Handling resetting bounds to be computed again
    this.bounding_box = null;
    this.bounding_sphere = null;

    return this;
}

Group.prototype.make_octrees = function() {
    for (const child of this.children) {
        if (child.isGroup) {
            child.make_octrees();
        }
        else if (child.isMesh) {
            if (child.octree === null) child.make_octree()
        }
    }
}
//#endregion

Scene.prototype.make_octrees = function() {
    for (const child of this.children) {
        if (child.isGroup) {
            child.make_octrees();
        }
        else if (child.isMesh) {
            if (child.octree === null) child.make_octree();
        }
    }
}

// Class to hold ranges of triangle indices
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
        if (last_range.start <= index && index <= last_range.end) {
            //this might not be ascending but it's still fine
            return;
        }
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
    /**
     * @param {IndexRanges} triangle_indices
     * @param {Mesh} mesh
     * @param {Box3} bounding_box
     */
    constructor(mesh, triangle_indices = null, bounding_box = null, depth = 0) {
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

        //#region triangle_indices
        if (triangle_indices === null && mesh !== undefined) {
            triangle_indices = get_indices(mesh);
        }
        else if (triangle_indices === null) {
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

        // Creating arrays to store indices of children triangles
        /** @type {Array<IndexRanges>} */
        const sub_indices = Array(8);
        for (let i = 0; i < 8; i++) {
            sub_indices[i] = new IndexRanges();
        }

        // Populating children indices by intersecting triangles with boxes
        for (const id_range of triangle_indices.ranges) {
            for (let index = id_range.start; index <= id_range.end; index += 3)
            {
                const triangle = get_triangle(index, mesh);
                let in_child = false;

                if (!this.box.intersectsTriangle(triangle)) {
                    throw new Error("given triangle not in box");
                }

                for (let i = 0; i < 8; i++) {

                    if (sub_boxes[i].intersectsTriangle(triangle)) {
                        sub_indices[i].add(index);
                        in_child = true;
                    }

                }

                if (!in_child) {
                    throw new Error("triangle on none of the children")
                }
            }
        }

        // Creating children from sub-boxes and their triangle indices
        /** @type {Array<OctreeNode | OctreeLeaf>} */
        const children = [];
        
        for (let i = 0; i < 8; i++) {
            let nb_tris = sub_indices[i].count
            if (nb_tris > 0) {
                if (nb_tris < MAX_TRIS /*|| nb_tris * 2 < depth*/) {
                    children.push(new OctreeLeaf(sub_indices[i], sub_boxes[i]))
                }
                else {
                    let child = new OctreeNode(mesh, sub_indices[i], sub_boxes[i], depth + 1);
                    if (child.children.length == 0) {
                        throw new Error("empty child");
                    }
                    children.push(child);
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

    /**
     * @returns {{object: Object3D, point: Vector3, distance: Number}}
     * @param {Mesh} mesh 
     * @param {Raycaster} raycaster 
     * @param {Ray} local_ray 
     * @param {Number} max_dist 
     */
    raycast_first(mesh, raycaster, local_ray, max_dist = Infinity) {
        const ray = raycaster.ray;

        let node_dists = [];
        for (const child of this.children) {
            let dist = 0;

            if (!child.box.containsPoint(ray.origin)) {
                let point = new Vector3();
                if (ray.intersectBox(child.box, point) === null) continue;
                dist = ray.origin.distanceTo(point);
            }

            if (dist >= max_dist) continue;

            node_dists.push({
                node: child,
                distance: dist
            });
        }

        node_dists.sort(ascSort);

        let intersect = {point: null, distance: max_dist};
        for (const node_dist of node_dists) {
            if (node_dist.distance >= intersect.distance) break;

            let new_intersect = node_dist.node.raycast_first(mesh, raycaster, local_ray, max_dist);
            if (new_intersect.distance < intersect.distance) {
                intersect = new_intersect;
            }
        }
        return intersect;
    }
}

class OctreeLeaf {
    /**
     * @param {IndexRanges} triangle_indices
     * @param {Mesh} mesh
     * @param {Box3} bounding_box
     */
    constructor(triangle_indices, bounding_box) {
        this.box = bounding_box;
        this.indices = triangle_indices;
    }
    
    /**
     * @returns {{object: Object3D, point: Vector3, distance: Number}}
     * @param {Mesh} mesh 
     * @param {Raycaster} raycaster 
     * @param {Ray} local_ray 
     * @param {Number} max_dist 
     */
    raycast_first(mesh, raycaster, local_ray, max_dist = Infinity) {
        let intersection = {point: null, distance: max_dist};

        for (const range of this.indices.ranges) {
            for (let tri_id = range.start; tri_id <= range.end; tri_id += 3) {
                let new_inter = ray_intersect_triangle(mesh, tri_id, raycaster, local_ray);
                if (new_inter.distance < intersection.distance) {
                    intersection = new_inter;
                }
            }
        }

        return intersection;
    }


}
//#endregion

// Functions to build the Octree
//#region Octree_utils
/**
 * @returns {Triangle}
 * @param {Number} tri_id
 * @param {Mesh} mesh
 */
function get_triangle(tri_id, mesh) {
    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;

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

    let pA = new Vector3(), pB = new Vector3(), pC = new Vector3();
    mesh.getVertexPosition(a, pA);
    mesh.getVertexPosition(b, pB);
    mesh.getVertexPosition(c, pC);

    let matrix = mesh.matrixWorld;
    return new Triangle(pA.applyMatrix4(matrix), pB.applyMatrix4(matrix), pC.applyMatrix4(matrix))
}

/**
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
    else if ( position !== undefined ) {
        count = position.count;
    }

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

/**
 * @returns {{object: Object3D, point: Vector3, distance: Number}}
 * @param {Mesh} mesh
 * @param {Number} max_dist
 */
Raycaster.prototype.intersect_first_in_mesh = function( mesh, max_dist = Infinity ) {
		
    let inverseWorld = new Matrix4().copy(mesh.matrixWorld).invert();
    let local_ray = new Ray().copy(this.ray).applyMatrix4(inverseWorld);
    
    if (mesh.octree === undefined || mesh.octree === null) {
        let intersects = [];
        mesh._computeIntersections(this, intersects, local_ray);
        return intersects[0];
    }

    else {
        return mesh.octree.raycast_first(mesh, this, local_ray, max_dist);
    }
}

/**
 * @returns {{object: Object3D, point: Vector3, distance: Number}}
 * @param {Scene | Group | Mesh} object
 * @param {Number} max_dist
 */
Raycaster.prototype.intersect_first = function(object, max_dist = Infinity) {

    if ( object.isMesh ) return this.intersect_first_in_mesh(object, max_dist);
    if ( ! (object.isGroup || object.isScene) ) return -Infinity;

    /**@type {Array<{object: Mesh | Group, distance: Number}>}*/
    let dist_objs = [];

    /**@type {{object: Object3D, point: Vector3, distance: Number}}*/
    let intersection = {
        object: null,
        point: null,
        distance: max_dist
    };

    for (let i = 0; i < object.children.length; i++) {
        let child = object.children[i];

        if ( !(child.isMesh || child.isGroup) ) continue;

        let dist = dist_to_bounds( child, this.ray );

        if (!isFinite(dist) /*&& dist > 0*/) continue;	// not intersecting

        dist_objs.push({
            object: child,
            distance: dist
        });
    }

    dist_objs.sort( ascSort );

    for (let i = 0; i < dist_objs.length; i++) {

        if (dist_objs[i].distance >= intersection.distance) {
            return intersection;
        }

        /**@type {{object: Object3D, point: Vector3, distance: Number}}*/
        let new_inter;
        let obj = dist_objs[i].object;
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

/**
 * @returns {Number}
 * @param {Mesh | Group} object
 * @param {Ray} ray
 */
function dist_to_bounds( object, ray ) {
	// Only classes with get_bounding_XXX implemented are supported
	if ( ! (object.isGroup || object.isMesh) ) return -Infinity;

	const box = object.get_bounding_box();
	const sphere = object.get_bounding_sphere();
	const origin = ray.origin;

	let box_dist = 0, sphere_dist = 0;

	if (box.containsPoint(origin)) {
		box_dist = -1;
	}
	else {
		let box_inter = new Vector3();
		if (ray.intersectBox(box, box_inter) == null) box_dist = Infinity;
		else box_dist = origin.distanceTo(box_inter);
	}

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

	return Math.max(box_dist, sphere_dist);
}

function ascSort( a, b ) {

	return a.distance - b.distance;

}

/**
 * @returns {{point: Vector3, distance: Number}}
 * @param {Mesh} mesh
 * @param {Number} tri_id
 * @param {Raycaster} raycaster
 * @param {Ray} local_ray
 */
function ray_intersect_triangle(mesh, tri_id, raycaster, local_ray) {
        
    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;

    const uv = mesh.geometry.attributes.uv;
    const uv1 = mesh.geometry.attributes.uv1;
    const normal = mesh.geometry.attributes.normal;

    let a, b, c;

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
    
    let intersection = checkGeometryIntersection( mesh, default_material, raycaster, local_ray, uv, uv1, normal, a, b, c );

    if ( intersection ) {
        intersection.faceIndex = Math.floor( tri_id / 3 ); // triangle number in non-indexed buffer semantics
        return intersection;
    }

    else return {distance: Infinity};
}
//#endregion

export { Scene, Group, Mesh, Raycaster }