// WebGL2 VertexArrayObject class
//
// (polyfilled/extended in WebGL1)
//
// NOTE: Desktop OpenGL cannot disable attribute 0:
// https://stackoverflow.com/questions/20305231/webgl-warning-attribute-0-is-disabled-
// this-has-significant-performance-penalt

import GL from '../constants';
import Resource from './resource';
import Accessor from './accessor';
import Buffer from './buffer';
import {isWebGL2} from '../webgl-utils';
import {glKey} from '../webgl-utils/constants-to-keys';
import {getCompositeGLType} from '../webgl-utils/attribute-utils';
import {getScratchArray} from '../utils/array-utils-flat';
import {log, formatValue, assert} from '../utils';

/* eslint-disable camelcase */
const OES_vertex_array_object = 'OES_vertex_array_object';

const GL_ELEMENT_ARRAY_BUFFER = 0x8893;

const ERR_ELEMENTS = 'elements must be GL.ELEMENT_ARRAY_BUFFER';
const ERR_ATTRIBUTE_TYPE = 'VertexArray: attributes must be Buffer or typed array constant';

export default class VertexArray extends Resource {

  // Not correct if webgl1 polyfills not installed
  static isSupported(gl) {
    return isWebGL2(gl) || gl.getExtension(OES_vertex_array_object);
  }

  // Returns the global (null) vertex array object. Exists even when no extension available
  static getDefaultArray(gl) {
    log.deprecated('VertexArray.getDefaultArray', 'new VertexArray(gl, {handle: null})');
    gl.luma = gl.luma || {};
    if (!gl.luma.defaultVertexArray) {
      gl.luma.defaultVertexArray = new VertexArray(gl, {handle: null});
    }
    return gl.luma.defaultVertexArray;
  }

  static getMaxAttributes(gl) {
    // TODO - should be cached per context
    VertexArray.MAX_VERTEX_ATTRIBS = VertexArray.MAX_VERTEX_ATTRIBS ||
      gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    return VertexArray.MAX_VERTEX_ATTRIBS;
  }

  // Create a VertexArray
  constructor(gl, opts = {}) {
    // Use program's id if program but no id is supplied
    const id = opts.id || opts.program && opts.program.id;
    super(gl, Object.assign({}, opts, {id}));

    this.configuration = null;

    // Extracted information
    this.elements = null;
    this.values = null;
    this.infos = null;
    this.accessors = null;
    this.unused = null;
    this.drawParams = null;
    this.buffer = null; // For attribute 0 on desktops, and created when unbinding buffers

    // Issue errors when using removed methods
    this.stubRemovedMethods('VertexArray', 'v6.0', [
      'setBuffers', 'setGeneric', 'clearBindings', 'setLocations', 'setGenericValues',
      'setDivisor', 'enable', 'disable'
    ]);

    this._initialize(opts);
    Object.seal(this);
  }

  delete() {
    super.delete();
    if (this.buffer) {
      this.buffer.delete();
    }
  }

  get MAX_ATTRIBUTES() {
    return VertexArray.getMaxAttributes(this.gl);
  }

  setProps(props) {
    if ('program' in props) {
      this.configuration = props.program && props.program.configuration;
    }
    if ('configuration' in props) {
      this.configuration = props.configuration;
    }
    if ('attributes' in props) {
      this.setAttributes(props.attributes);
    }
    if ('elements' in props) {
      this.setElements(props.elements);
    }
    if ('bindOnUse' in props) {
      props = props.bindOnUse;
    }
    return this;
  }

  // Resets all attributes (to default valued constants)
  reset(clear = true) {
    if (clear) {
      this._unbindBuffers();
      this.bind(() => {
        // Clear elements buffer
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, null);
        for (let i = 0; i < this.MAX_ATTRIBUTES; i++) {
          this.setConstant(i, [0, 0, 0, 1]); // match assumed WebGL defaults
        }
      });
    }

    this.elements = null;
    this.values = new Array(this.MAX_VERTEX_ATTRIBS).fill(null);
    this.infos = new Array(this.MAX_VERTEX_ATTRIBS).fill({});
    this.accessors = new Array(this.MAX_VERTEX_ATTRIBS).fill(null);
    this.unused = [];

    // Auto detects draw params
    this.drawParams = {
      isInstanced: false,
      // indexing is autodetected - buffer with target gl.ELEMENT_ARRAY_BUFFER
      // index type is saved for drawElement calls
      isIndexed: false,
      indexType: null
    };

    return this;
  }

  // Set (bind) an array or map of vertex array buffers, either in numbered or named locations.
  // For names that are not present in `location`, the supplied buffers will be ignored.
  // if a single buffer of type GL.ELEMENT_ARRAY_BUFFER is present, it will be set as elements
  //   Signatures:
  //     {attributeName: buffer}
  //     {attributeName: [buffer, accessor]}
  //     {attributeName: (typed) array} => constant
  setAttributes(attributes) {
    this.bind(() => {
      for (const locationOrName in attributes) {
        const value = attributes[locationOrName];
        if (value instanceof Buffer) {
          //  Signature: attributeName: buffer
          this.setBuffer(locationOrName, value);
        } else if (Array.isArray(value) && value.length && value[0] instanceof Buffer) {
          // Signature: attributeName: [buffer, accessor]
          const buffer = value[0];
          const accessor = value[1];
          this.setBuffer(locationOrName, buffer, accessor);
        } else if (ArrayBuffer.isView(value) || Array.isArray(value)) {
          //  Signature: attributeName: (short) (typed) array => constant
          this.setConstant(locationOrName, value);
        } else {
          throw new Error(ERR_ATTRIBUTE_TYPE);
        }
      }

      // Make sure we don't leave any bindings
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
    });

    return this;
  }

  // Set (bind) an elements buffer, for indexed rendering.
  // Must be a Buffer bound to GL.ELEMENT_ARRAY_BUFFER. Constants not supported
  setElements(elementBuffer = null, opts = {}) {
    assert(!elementBuffer || elementBuffer.target === GL_ELEMENT_ARRAY_BUFFER, ERR_ELEMENTS);

    this.elements = elementBuffer;

    if (this.hasVertexArrays) {
      this._setElementBuffer();
    }

    // Auto-deduce isIndexed draw param
    this.drawParams.isIndexed = Boolean(elementBuffer);
    if (elementBuffer) {
      const options = elementBuffer.accessor.merge(opts);
      this.drawParams.indexType = options.type;
      // TODO - autodeduce number of indices
      // this.drawParams.indexCount = elementBuffer.getElementCount();
    } else {
      delete this.drawParams.indexType;
    }

    return this;
  }

  // Set a location in vertex attributes array to a buffer
  setBuffer(locationOrName, buffer, opts = {}) {
    const {gl} = this;

    // Check target
    if (buffer.target === gl.ELEMENT_ARRAY_BUFFER) {
      return this.setElements(buffer);
    }

    const location = this._getAttributeIndex(locationOrName);
    if (location < 0) {
      this.unused[locationOrName] = buffer;
      log.once(3, () => `unused buffer attribute ${locationOrName} in ${this.id}`)();
      return this;
    }

    const accessInfo = this._getAttributeInfo(locationOrName, buffer, opts);
    const name = accessInfo ? accessInfo.name : String(location);

    // Override with any additional attribute configuration params
    let accessor = accessInfo ? accessInfo.accessor : new Accessor();
    accessor = accessor.getOptions(buffer, buffer.accessor, opts);

    this.values[location] = buffer;
    this.accessors[location] = accessor;
    this.infos[location] = {location, name, accessor};

    const {size, type, divisor} = accessor;
    assert(Number.isFinite(size) && Number.isFinite(type));

    if (this.hasVertexArrays) {
      this._setBuffer(location, buffer, accessor);
    }

    // Auto deduce isInstanced drawParam
    const isInstanced = divisor > 0;
    this.drawParams.isInstanced = this.drawParams.isInstanced || isInstanced;
    // this.drawParams.bufferLength[] = 

    return this;
  }

  // Set attribute to constant value (small typed array corresponding to one vertex' worth of data)
  // TODO - handle single values for size 1 attributes?
  // TODO - convert classic arrays based on known type?
  setConstant(locationOrName, arrayValue, opts) {
    const accessInfo = this._getAttributeInfo(locationOrName, arrayValue, opts);
    if (!accessInfo) {
      this.unused[locationOrName] = arrayValue;
      log.warn(() => `${this.id} unused constant attribute ${locationOrName}`)();
      return this;
    }

    // TODO - read type if provided
    if (Array.isArray(arrayValue)) {
      arrayValue = new Float32Array(arrayValue);
    }

    const {location} = accessInfo;

    this.bind(() => {
      this._setConstant(location, arrayValue);

      // To use the constant value, disable reading from arrays
      this.gl.disableVertexAttribArray(location);

      // Reset instanced divisor (not strictly needed)
      this.gl.vertexAttribDivisor(location, 0);
    });

    // Save the value for debugging
    this.values[location] = arrayValue;

    return this;
  }

  // Workaround for Chrome TransformFeedback binding issue
  // If required, unbind temporarily to avoid conflicting with TransformFeedback
  unbindBuffers() {
    this._unbindBuffers();
    return this;
  }

  // Workaround for Chrome TransformFeedback binding issue
  // If required, rebind rebind after temporary unbind
  bindBuffers() {
    this._bindBuffers();
    return this;
  }

  // PRIVATE

  _initialize(props = {}) {
    this.reset(false);
    this.configuration = null;
    this.bindOnUse = false;
    return this.setProps(props);
  }

  _getAttributeInfo(attributeName) {
    return this.configuration && this.configuration.getAttributeInfo(attributeName);
  }

  _getAttributeIndex(locationOrName) {
    if (this.configuration) {
      return this.configuration.getLocation(locationOrName);
    }
    const location = Number(locationOrName);
    if (Number.isFinite(location)) {
      return location;
    }
    return -1;
  }

  _updateAttributeZeroBuffer(length = 4) {
    // Create buffer only when needed, and reuse it (avoids inflating buffer creation statistics)
    const constant = this.values[0];
    if (ArrayBuffer.isView(constant)) {
      debugger;
      const size = 1;
      this.buffer = this.buffer || new Buffer(this.gl, {size});
    }
  }

  _unbindBuffers() {
    this.bind(() => {
      // WebGL offers disabling, but no clear way to set a VertexArray buffer to `null`
      // But Chrome does not like buffers that are bound to several binding points.
      // So we just bind all the attributes to the dummy "attribute zero" buffer
      this.buffer = this.buffer || new Buffer(this.gl, {size: 4});

      for (const location in this.values) {
        if (this.values[location] instanceof Buffer) {
          this.gl.disableVertexAttribArray(location);
          this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer.handle);
          this.gl.vertexAttribPointer(location, 1, this.gl.FLOAT, false, 0, 0);
        }
      }
    });
  }

  _bindBuffers() {
    this.bind(() => {
      for (const location in this.values) {
        const buffer = this.values[location];
        if (buffer instanceof Buffer) {
          this.setBuffer(location, buffer);
        }
      }
    });
  }

  // Updates all constant attribute values (constants are used when vertex attributes are disabled).
  // This needs to be done repeatedly since in contrast to buffer bindings,
  // constants are stored on the WebGL context, not the VAO
  _setConstantAttributes() {
    for (const location in this.values) {
      const constant = this.values[location];
      if (ArrayBuffer.isView(constant)) {
        this._setConstant(Number(location), constant);
        this.gl.disableVertexAttribArray(Number(location));
        this.gl.vertexAttribDivisor(Number(location), 0);
      }
    }
  }

  _setElementBuffer() {
    // The GL_ELEMENT_ARRAY_BUFFER_BINDING is stored on the VertexArray...
    this.bind(() => {
      this.gl.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, this.elements ? this.elements.handle : null);
    });
  }

  _setBuffer(location, buffer, accessor) {
    const {gl} = this;
    const {size, type, stride, offset, normalized, integer, divisor} = accessor;

    this.bind(() => {
      // A non-zero buffer object must be bound to the GL_ARRAY_BUFFER target
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.handle);

      // WebGL2 supports *integer* data formats, i.e. GPU will see integer values
      if (integer) {
        assert(isWebGL2(gl));
        gl.vertexAttribIPointer(location, size, type, stride, offset);
      } else {
        // Attaches ARRAY_BUFFER with specified buffer format to location
        gl.vertexAttribPointer(location, size, type, normalized, stride, offset);
      }
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, divisor || 0);
      // NOTE We don't unbind buffer here, typically another buffer will be bound just after
    });
  }

  // Note: Constants are stored on the WebGL context, not the VAO
  // TODO - cache these to avoid setting them unnecessarily?
  // TODO - use known type (in configuration or passed in) to allow non-typed arrays?
  _setConstant(location, array) {
    switch (array.constructor) {
    case Float32Array: this._setConstantFloatArray(location, array); break;
    case Int32Array: this._setConstantIntArray(location, array); break;
    case Uint32Array: this._setConstantUintArray(location, array); break;
    default: assert(false);
    }
  }

  _setConstantFloatArray(location, array) {
    const {gl} = this;
    switch (array.length) {
    case 1: gl.vertexAttrib1fv(location, array); break;
    case 2: gl.vertexAttrib2fv(location, array); break;
    case 3: gl.vertexAttrib3fv(location, array); break;
    case 4: gl.vertexAttrib4fv(location, array); break;
    default: assert(false);
    }
  }

  _setConstantIntArray(location, array) {
    const {gl} = this;
    assert(isWebGL2(gl));
    switch (array.length) {
    case 1: gl.vertexAttribI1iv(location, array); break;
    case 2: gl.vertexAttribI2iv(location, array); break;
    case 3: gl.vertexAttribI3iv(location, array); break;
    case 4: gl.vertexAttribI4iv(location, array); break;
    default: assert(false);
    }
  }

  _setConstantUintArray(location, array) {
    const {gl} = this;
    assert(isWebGL2(gl));
    switch (array.length) {
    case 1: gl.vertexAttribI1uiv(location, array); break;
    case 2: gl.vertexAttribI2uiv(location, array); break;
    case 3: gl.vertexAttribI3uiv(location, array); break;
    case 4: gl.vertexAttribI4uiv(location, array); break;
    default: assert(false);
    }
  }

  // RESOURCE IMPLEMENTATION

  _createHandle() {
    // this.hasVertexArrays = VertexArray.isSupported(this.gl);
    if (this.hasVertexArrays) {
      return this.gl.createVertexArray();
    }
    return null;
  }

  _deleteHandle(handle) {
    if (this.hasVertexArrays) {
      this.gl.deleteVertexArray(handle);
    }
    return [this.elements];
    // return [this.elements, ...this.buffers];
  }

  // Bind for use
  // When a vertex array is about to be used, we must:
  // - Set constant attributes (since these are stored on the context and reset on bind)
  // - Check if we need to initialize the buffer
  bindForUse(length, func) {
    if (Number.isFinite(length)) {
      this._updateAttributeZeroBuffer(length);
    }
    // Make sure that any constant attributes are updated (stored on the context, not the VAO)
    this._setConstantAttributes();
    if (!this.hasVertexArrays) {
      if (this.elements) {
        this._setElementBuffer(this.elements);
      }
      this._bindBuffers();
    }
    const value = this.bind(func);
    if (!this.hasVertexArrays) {
      this._unbindBuffers();
    }
    return value;
  }

  // Bind for config

  _bindHandle(handle) {
    if (this.hasVertexArrays) {
      this.gl.bindVertexArray(handle);
    }
  }

  // Generic getter for information about a vertex attribute at a given position
  _getParameter(pname, {location}) {
    assert(Number.isFinite(location));
    return this.bind(() => {
      switch (pname) {
      case GL.VERTEX_ATTRIB_ARRAY_POINTER: return this.gl.getVertexAttribOffset(location, pname);
      default: return this.gl.getVertexAttrib(location, pname);
      }
    });
  }

  _getDebugTable({header = 'Attributes'} = {}) {
    if (!this.configuration) {
      return {};
    }

    const table = {}; // {[header]: {}};

    // Add index (elements) if available
    if (this.elements) {
      // const elements = Object.assign({size: 1}, this.elements);
      table.ELEMENT_ARRAY_BUFFER =
        this._getDebugTableRow(this.elements, null, header);
    }

    // Add used attributes
    const attributes = this.values;

    for (const attributeName in attributes) {
      const info = this._getAttributeInfo(attributeName);
      if (info) {
        let rowHeader = `${attributeName}: ${info.name}`;
        const accessor = this.accessors[info.location];
        if (accessor) {
          const typeAndName = getCompositeGLType(accessor.type, accessor.size);
          if (typeAndName) { // eslint-disable-line
            rowHeader = `${attributeName}: ${info.name} (${typeAndName.name})`;
          }
        }
        table[rowHeader] =
          this._getDebugTableRow(attributes[attributeName], accessor, header);
      }
    }

    return table;
  }

  /* eslint-disable max-statements */
  _getDebugTableRow(attribute, accessor, header) {
    const {gl} = this;
    // const round = xnum => Math.round(num * 10) / 10;

    let type = 'NOT PROVIDED';
    let size = 'N/A';
    let verts = 'N/A';
    let bytes = 'N/A';

    let isInteger;
    let marker;
    let value;

    if (accessor) {
      type = accessor.type;
      size = accessor.size;

      // Generate a type name by dropping Array from Float32Array etc.
      type = String(type).replace('Array', '');

      // Look for 'nt' to detect integer types, e.g. Int32Array, Uint32Array
      isInteger = type.indexOf('nt') !== -1;
    }

    if (attribute instanceof Buffer) {
      const buffer = attribute;

      const {data, modified} = buffer.getDebugData();
      marker = modified ? '*' : '';

      value = data;
      bytes = buffer.bytes;
      verts = bytes / data.BYTES_PER_ELEMENT / size;

      let format;

      if (accessor) {
        const instanced = accessor.divisor > 0;
        format = `${instanced ? 'I ' : 'P '} ${verts} (x${size}=${bytes} bytes ${glKey(gl, type)})`;
      } else {
        // element buffer
        isInteger = true;
        format = `${bytes} bytes`;
      }

      return {
        [header]: `${marker}${formatValue(value, {size, isInteger})}`,
        'Format ': format
      };
    }

    // CONSTANT VALUE
    value = attribute;
    size = attribute.length;
    // Generate a type name by dropping Array from Float32Array etc.
    type = String(attribute.constructor.name).replace('Array', '');
    // Look for 'nt' to detect integer types, e.g. Int32Array, Uint32Array
    isInteger = type.indexOf('nt') !== -1;

    return {
      [header]: `${formatValue(value, {size, isInteger})} (constant)`,
      'Format ': `${size}x${type} (constant)`
    };

  }
  /* eslint-ensable max-statements */
}
