'use strict';

import array from '../array/array';
import core from '../core';
import dom from '../dom/dom';
import features from '../dom/features';
import html from '../html/html';
import object from '../object/object';
import string from '../string/string';
import Attribute from '../attribute/Attribute';
import ComponentCollector from '../component/ComponentCollector';
import EventEmitterProxy from '../events/EventEmitterProxy';
import EventHandler from '../events/EventHandler';
import EventsCollector from './EventsCollector';
import SurfaceCollector from './SurfaceCollector';

/**
 * Component collects common behaviors to be followed by UI components, such
 * as Lifecycle, bounding box element creation, CSS classes management,
 * events encapsulation and surfaces support. Surfaces are an area of the
 * component that can have information rendered into it. A component
 * manages multiple surfaces. Surfaces are only rendered when its content is
 * modified, representing render performance gains. For each surface, render
 * attributes could be associated, when the render context of a surface gets
 * modified the component Lifecycle re-paints the modified surface
 * automatically.
 *
 * Example:
 *
 * <code>
 * class CustomComponent extends Component {
 *   constructor(config) {
 *     super(config);
 *   }
 *
 *   decorateInternal() {
 *   }
 *
 *   renderInternal() {
 *     this.element.appendChild(this.getSurfaceElement('header'));
 *     this.element.appendChild(this.getSurfaceElement('bottom'));
 *   }
 *
 *   getSurfaceContent(surfaceId, surfaceElementId) {
 *   }
 *
 *   attached() {
 *   }
 *
 *   detached() {
 *   }
 * }
 *
 * CustomComponent.ATTRS = {
 *   title: { value: 'Title' },
 *   fontSize: { value: '10px' }
 * };
 *
 * CustomComponent.SURFACES = {
 *   header: { renderAttrs: ['title', 'fontSize'] },
 *   bottom: { renderAttrs: ['fontSize'] }
 * };
 * </code>
 *
 * @param {!Object} opt_config An object with the initial values for this component's
 *   attributes.
 * @constructor
 * @extends {Attribute}
 */
class Component extends Attribute {
	constructor(opt_config) {
		super(opt_config);

		/**
		 * Holds data about all surfaces that were collected through the
		 * `replaceSurfacePlaceholders_` method.
		 * @type {!Array}
		 * @protected
		 */
		this.collectedSurfaces_ = [];

		/**
		 * Gets all nested components.
		 * @type {!Array<!Component>}
		 */
		this.components = {};

		/**
		 * Whether the element is being decorated.
		 * @type {boolean}
		 * @protected
		 */
		this.decorating_ = false;

		/**
		 * Holds events that were listened through the `delegate` Component function.
		 * @type {EventHandler}
		 * @protected
		 */
		this.delegateEventHandler_ = null;

		/**
		 * Instance of `EventEmitterProxy` which proxies events from the component's
		 * element to the component itself.
		 * @type {EventEmitterProxy}
		 * @protected
		 */
		this.elementEventProxy_ = null;

		/**
		 * The `EventHandler` instance for events attached from the `events` attribute.
		 * @type {!EventHandler}
		 * @protected
		 */
		this.eventsAttrHandler_ = new EventHandler();

		/**
		 * Collects inline events from html contents.
		 * @type {!EventsCollector}
		 * @protected
		 */
		this.eventsCollector_ = new EventsCollector(this);

		/**
		 * Holds the number of generated ids for each surface's contents.
		 * @type {!Object}
		 * @protected
		 */
		this.generatedIdCount_ = {};

		/**
		 * Whether the element is in document.
		 * @type {boolean}
		 */
		this.inDocument = false;

		/**
		 * The ids of the surfaces registered by this component.
		 * @type {!Object<string, boolean>}
		 * @protected
		 */
		this.surfaceIds_ = {};

		/**
		 * Whether the element was rendered.
		 * @type {boolean}
		 */
		this.wasRendered = false;

		/**
		 * The component's element will be appended to the element this variable is
		 * set to, unless the user specifies another parent when calling `render` or
		 * `attach`.
		 * @type {!Element}
		 */
		this.DEFAULT_ELEMENT_PARENT = document.body;

		core.mergeSuperClassesProperty(this.constructor, 'ELEMENT_CLASSES', this.mergeElementClasses_);
		core.mergeSuperClassesProperty(this.constructor, 'ELEMENT_TAG_NAME', array.firstDefinedValue);
		core.mergeSuperClassesProperty(this.constructor, 'SURFACE_TAG_NAME', array.firstDefinedValue);
		this.addSurfacesFromStaticHint_(opt_config);

		this.delegateEventHandler_ = new EventHandler();

		this.created_();
	}

	/**
	 * Adds the listeners specified in the given object.
	 * @param {Object} events
	 * @protected
	 */
	addListenersFromObj_(events) {
		var eventNames = Object.keys(events || {});
		for (var i = 0; i < eventNames.length; i++) {
			var info = this.extractListenerInfo_(events[eventNames[i]]);
			if (info.fn) {
				var handler;
				if (info.selector) {
					handler = this.delegate(eventNames[i], info.selector, info.fn);
				} else {
					handler = this.on(eventNames[i], info.fn);
				}
				this.eventsAttrHandler_.add(handler);
			}
		}
	}

	/**
	 * Adds a simple attribute with the given name, if it doesn't exist yet.
	 * @param {string} attrName
	 * @param {Object=} opt_initialValue Optional initial value for the new attr.
	 * @protected
	 */
	addMissingAttr_(attrName, initialValue) {
		if (!this.getAttrConfig(attrName)) {
			this.addAttr(attrName, {}, initialValue);
		}
	}

	/**
	 * Overrides `addSingleListener_` from `EventEmitter`, so we can create
	 * the `EventEmitterProxy` instance only when it's needed for the first
	 * time.
	 * @param {string} event
	 * @param {!Function} listener
	 * @param {Function=} opt_origin The original function that was added as a
	 *   listener, if there is any.
	 * @protected
	 * @override
	 */
	addSingleListener_(event, listener, opt_origin) {
		if (!this.elementEventProxy_ &&
			dom.supportsEvent(this.constructor.ELEMENT_TAG_NAME_MERGED, event)) {
			this.elementEventProxy_ = new EventEmitterProxy(this.element, this);
		}
		super.addSingleListener_(event, listener, opt_origin);
	}

	/**
	 * Registers a surface to the component. Surface elements are not
	 * automatically appended to the component element.
	 * @param {string} surfaceId The surface id to be registered.
	 * @param {Object=} opt_surfaceConfig Optional surface configuration.
	 * @param {Object=} opt_config Optional component configuration.
	 * @chainable
	 */
	addSurface(surfaceId, opt_surfaceConfig, opt_config) {
		var config = opt_surfaceConfig || {};
		config.cacheState = Component.Cache.NOT_INITIALIZED;

		var surfaceElementId = this.getSurfaceElementId_(surfaceId, config);
		this.surfaceIds_[surfaceElementId] = true;
		Component.surfacesCollector.addSurface(surfaceElementId, config);

		if (config.componentName) {
			this.createSubComponent_(config.componentName, surfaceElementId);
		}
		this.cacheSurfaceRenderAttrs_(surfaceElementId, opt_config);
		return this;
	}

	/**
	 * Registers surfaces to the component. Surface elements are not
	 * automatically appended to the component element.
	 * @param {!Object.<string, Object=>} configs An object that maps the names
	 *     of all the surfaces to be added to their configuration objects.
	 * @chainable
	 */
	addSurfaces(configs) {
		for (var surfaceId in configs) {
			this.addSurface(surfaceId, configs[surfaceId]);
		}
		return this;
	}

	/**
	 * Adds surfaces from super classes static hint.
	 * @param {Object=} opt_config This component's configuration object.
	 * @protected
	 */
	addSurfacesFromStaticHint_(opt_config) {
		core.mergeSuperClassesProperty(this.constructor, 'SURFACES', this.mergeObjects_);
		this.surfacesRenderAttrs_ = {};

		var configs = this.constructor.SURFACES_MERGED;
		for (var surfaceId in configs) {
			this.addSurface(surfaceId, object.mixin({}, configs[surfaceId]), opt_config);
		}
	}

	/**
	 * Invokes the attached Lifecycle. When attached, the component element is
	 * appended to the DOM and any other action to be performed must be
	 * implemented in this method, such as, binding DOM events. A component can
	 * be re-attached multiple times.
	 * @param {(string|Element)=} opt_parentElement Optional parent element
	 *     to render the component.
	 * @param {(string|Element)=} opt_siblingElement Optional sibling element
	 *     to render the component before it. Relevant when the component needs
	 *     to be rendered before an existing element in the DOM, e.g.
	 *     `component.render(null, existingElement)`.
	 * @protected
	 * @chainable
	 */
	attach(opt_parentElement, opt_siblingElement) {
		if (!this.inDocument) {
			this.renderElement_(opt_parentElement, opt_siblingElement);
			this.inDocument = true;
			if (!this.wasRendered) {
				this.updatePlaceholderSurfaces_();
			}
			this.attached();
		}
		return this;
	}

	/**
	 * Attaches inline listeners that are found on the element's string content.
	 * @protected
	 */
	attachInlineListeners_() {
		this.eventsCollector_.attachListeners(this.getElementContent_(''));
		this.elementContent_ = null;
	}

	/**
	 * Lifecycle. When attached, the component element is appended to the DOM
	 * and any other action to be performed must be implemented in this method,
	 * such as, binding DOM events. A component can be re-attached multiple
	 * times, therefore the undo behavior for any action performed in this phase
	 * must be implemented on the detach phase.
	 */
	attached() {}

	/**
	 * Builds a surface placeholder, attaching it to the given data.
	 * @param {string} surfaceElementId
	 * @param {Object=} opt_data
	 * @return {string}
	 */
	buildPlaceholder(surfaceElementId, opt_data) {
		if (surfaceElementId && opt_data) {
			opt_data.surfaceElementId = surfaceElementId;
			this.addSurface(surfaceElementId, opt_data);
		}
		return '%%%%~s' + (surfaceElementId ? '-' + surfaceElementId : '') + '~%%%%';
	}

	/**
	 * Caches the given content for the surface with the requested id.
	 * @param {string} surfaceElementId
	 * @param {string} content
	 */
	cacheSurfaceContent(surfaceElementId, content) {
		var cacheState = this.computeSurfaceCacheState_(content);
		var surface = this.getSurface(surfaceElementId);
		surface.cacheState = cacheState;
	}

	/**
	 * Caches surface render attributes into a O(k) flat map representation.
	 * Relevant for performance to calculate the surfaces group that were
	 * modified by attributes mutation.
	 * @param {string} surfaceElementId The surface id to be cached into the flat map.
	 * @param {Object=} opt_config Optional component configuration.
	 * @protected
	 */
	cacheSurfaceRenderAttrs_(surfaceElementId, opt_config) {
		var attrs = this.getSurface(surfaceElementId).renderAttrs || [];
		for (var i = 0; i < attrs.length; i++) {
			if (!this.surfacesRenderAttrs_[attrs[i]]) {
				this.surfacesRenderAttrs_[attrs[i]] = {};
				this.addMissingAttr_(attrs[i], opt_config ? opt_config[attrs[i]] : null);
			}
			this.surfacesRenderAttrs_[attrs[i]][surfaceElementId] = true;
		}
	}

	/**
	 * Checks if the given content has an element tag with the given id.
	 * @param {!Element|string} content
	 * @param {string} id
	 * @return {boolean}
	 * @protected
	 */
	checkHasElementTag_(content, id) {
		return core.isString(content) ? content.indexOf(' id="' + id + '"') !== -1 : content.id === id;
	}

	/**
	 * Compares cache states.
	 * @param {number} currentCacheState
	 * @param {number} previousCacheState
	 * @return {boolean} True if there's a cache hit, or false for cache miss.
	 */
	compareCacheStates_(currentCacheState, previousCacheState) {
		return currentCacheState !== Component.Cache.NOT_INITIALIZED &&
			currentCacheState !== Component.Cache.NOT_CACHEABLE &&
			currentCacheState === previousCacheState;
	}

	/**
	 * Computes the cache state for the surface content. If value is string, the
	 * cache state is represented by its hashcode.
	 * @param {Object} value The value to calculate the cache state.
	 * @return {Object} The computed cache state.
	 * @protected
	 */
	computeSurfaceCacheState_(value) {
		if (core.isString(value)) {
			if (features.checkAttrOrderChange()) {
				value = this.convertHtmlToBrowserFormat_(value);
			}
			return string.hashCode(value);
		}
		return Component.Cache.NOT_CACHEABLE;
	}

	/**
	 * Converts the given html string to the format the current browser uses
	 * when html is rendered. This is done by rendering the html in a temporary
	 * element, and returning its resulting rendered html.
	 * @param {string} htmlString The html to be converted.
	 * @return {string}
	 * @protected
	 */
	convertHtmlToBrowserFormat_(htmlString) {
		var element = document.createElement('div');
		dom.append(element, htmlString);
		return element.innerHTML;
	}

	/**
	 * Creates a surface that was found via a string placeholder.
	 * @param {string=} opt_surfaceElementId
	 * @param {string=} opt_parentSurfaceElementId The id of the surface element that contains
	 *   the surface to be created, or undefined if there is none.
	 * @return {string} The element id of the created surface.
	 * @protected
	 */
	createPlaceholderSurface_(opt_surfaceElementId, opt_parentSurfaceElementId) {
		var surfaceElementId = opt_surfaceElementId;
		if (!core.isDefAndNotNull(surfaceElementId)) {
			surfaceElementId = this.generateSurfaceElementId_(opt_parentSurfaceElementId);
		}
		var surface = this.getSurface(surfaceElementId);
		if (!surface) {
			this.addSurface(surfaceElementId, {
				surfaceElementId: surfaceElementId
			});
		}
		return surfaceElementId;
	}

	/**
	 * Creates a sub component.
	 * @param {string} componentName
	 * @param {string} componentId
	 * @return {!Component}
	 * @protected
	 */
	createSubComponent_(componentName, componentId) {
		this.components[componentId] = Component.componentsCollector.createComponent(
			componentName,
			componentId,
			this.getSurface(componentId).componentData
		);
		return this.components[componentId];
	}

	/**
	 * Creates the surface element with its id namespaced to the component id.
	 * @param {string} surfaceElementId The id of the element for the surface to be
	 *   created.
	 * @return {Element} The surface element.
	 * @protected
	 */
	createSurfaceElement_(surfaceElementId) {
		var el = document.createElement(this.constructor.SURFACE_TAG_NAME_MERGED);
		el.id = surfaceElementId;
		return el;
	}

	/**
	 * Decorates this component as a subcomponent, meaning that no rendering is
	 * needed since it was already rendered by the parent component. Handles the
	 * same logics that `renderAsSubComponent`, but also makes sure that the
	 * surfaces content is updated if the html is incorrect for the given data.
	 */
	decorateAsSubComponent() {
		this.decorating_ = true;
		this.renderAsSubComponent();
		this.decorating_ = false;
	}

	/**
	 * Lifecycle. Internal implementation for decoration. Any extra operation
	 * necessary to prepare the component DOM must be implemented in this phase.
	 */
	decorateInternal() {}

	/**
	 * Listens to a delegate event on the component's element.
	 * @param {string} eventName The name of the event to listen to.
	 * @param {string} selector The selector that matches the child elements that
	 *   the event should be triggered for.
	 * @param {!function(!Object)} callback Function to be called when the event is
	 *   triggered. It will receive the normalized event object.
	 * @return {!DomEventHandle} Can be used to remove the listener.
	 */
	delegate(eventName, selector, callback) {
		var handle = dom.delegate(this.element, eventName, selector, callback);
		this.delegateEventHandler_.add(handle);
		return handle;
	}

	/**
	 * Invokes the detached Lifecycle. When detached, the component element is
	 * removed from the DOM and any other action to be performed must be
	 * implemented in this method, such as, unbinding DOM events. A component
	 * can be detached multiple times.
	 * @chainable
	 */
	detach() {
		if (this.inDocument) {
			this.element.parentNode.removeChild(this.element);
			this.inDocument = false;
			this.detached();
		}
		this.eventsCollector_.detachAllListeners();
		return this;
	}

	/**
	 * Lifecycle. When detached, the component element is removed from the DOM
	 * and any other action to be performed must be implemented in this method,
	 * such as, unbinding DOM events. A component can be detached multiple
	 * times, therefore the undo behavior for any action performed in this phase
	 * must be implemented on the attach phase.
	 */
	detached() {}

	/**
	 * Internal implementation for the creation phase of the component.
	 * @protected
	 */
	created_() {
		this.on('eventsChanged', this.onEventsChanged_);
		this.addListenersFromObj_(this.events);

		this.on('attrsChanged', this.handleAttributesChanges_);
		Component.componentsCollector.addComponent(this);
	}

	/**
	 * Lifecycle. Creates the component using existing DOM elements. Often the
	 * component can be created using existing elements in the DOM to leverage
	 * progressive enhancement. Any extra operation necessary to prepare the
	 * component DOM must be implemented in this phase. Decorate phase replaces
	 * render phase.
	 *
	 * Decoration Lifecycle:
	 *   decorate - Decorate is manually called.
	 *   decorateInternal - Internal implementation for decoration happens.
	 *   render surfaces - All surfaces content are rendered.
	 *   attribute synchronization - All synchronization methods are called.
	 *   attach - Attach Lifecycle is called.
	 * @chainable
	 */
	decorate() {
		if (this.inDocument) {
			throw new Error(Component.Error.ALREADY_RENDERED);
		}
		this.decorating_ = true;

		this.decorateInternal();

		// Need to go through all surface placeholders on decorate to make sure they are
		// properly created for the first time.
		this.replaceSurfacePlaceholders_(this.getElementContent_());

		this.renderSurfacesContent_(this.surfaceIds_); // TODO(edu): Sync surfaces on decorate?

		this.attachInlineListeners_();
		this.syncAttrs_();

		this.attach();

		this.decorating_ = false;
		this.wasRendered = true;

		return this;
	}

	/**
	 * Calls `dispose` on all subcomponents.
	 * @protected
	 */
	disposeSubComponents_() {
		var ids = Object.keys(this.components);
		for (var i = 0; i < ids.length; i++) {
			var component = this.components[ids[i]];
			if (!component.isDisposed()) {
				Component.componentsCollector.removeComponent(component);
				component.dispose();
			}
		}
		this.components = null;
	}

	/**
	 * @inheritDoc
	 */
	disposeInternal() {
		this.detach();

		if (this.elementEventProxy_) {
			this.elementEventProxy_.dispose();
			this.elementEventProxy_ = null;
		}

		this.delegateEventHandler_.removeAllListeners();
		this.delegateEventHandler_ = null;

		this.disposeSubComponents_();
		this.generatedIdCount_ = null;
		this.surfacesRenderAttrs_ = null;

		Object.keys(this.surfaceIds_).forEach(surfaceId => this.removeSurface(surfaceId));
		this.surfaceIds_ = null;

		super.disposeInternal();
	}

	/**
	 * Extracts listener info from the given value.
	 * @param {function()|string|{selector:string,fn:function()|string}} value
	 * @return {!{selector:string,fn:function()}}
	 * @protected
	 */
	extractListenerInfo_(value) {
		var info = {
			fn: value
		};
		if (core.isObject(value) && !core.isFunction(value)) {
			info.selector = value.selector;
			info.fn = value.fn;
		}
		if (core.isString(info.fn)) {
			info.fn = this.eventsCollector_.getListenerFn(info.fn);
		}
		return info;
	}

	/**
	 * Fires attributes synchronization changes for attributes.
	 * @protected
	 */
	syncAttrs_() {
		var attrNames = this.getAttrNames();
		for (var i = 0; i < attrNames.length; i++) {
			this.fireAttrChange_(attrNames[i]);
		}
	}

	/**
	 * Fires attributes synchronization changes for attributes.
	 * @param {Object.<string, Object>} changes Object containing the attribute
	 *     name as key and an object with newVal and prevVal as value.
	 * @protected
	 */
	syncAttrsFromChanges_(changes) {
		for (var attr in changes) {
			this.fireAttrChange_(attr, changes[attr]);
		}
	}

	/**
	 * Finds the element that matches the given id on this component. This searches
	 * on the document first, for performance. If the element is not found, it's
	 * searched in the component's element directly.
	 * @param {string} id
	 * @return {Element}
	 * @protected
	 */
	findElementById_(id) {
		return document.getElementById(id) || this.element.querySelector('#' + id);
	}

	/**
	 * Fires attribute synchronization change for the attribute.
	 * @param {Object.<string, Object>} change Object containing newVal and
	 *     prevVal keys.
	 * @protected
	 */
	fireAttrChange_(attr, opt_change) {
		var fn = this['sync' + attr.charAt(0).toUpperCase() + attr.slice(1)];
		if (core.isFunction(fn)) {
			if (!opt_change) {
				opt_change = {
					newVal: this[attr],
					prevVal: undefined
				};
			}
			fn.call(this, opt_change.newVal, opt_change.prevVal);
		}
	}

	/**
	 * Generates an id for a surface that was found inside the contents of the main
	 * element or of a parent surface.
	 * @param {string=} opt_parentSurfaceElementId The id of the parent surface, or undefined
	 *   if there is none.
	 * @return {string} The generated id.
	 */
	generateSurfaceElementId_(opt_parentSurfaceElementId) {
		var parentElementId = opt_parentSurfaceElementId || this.id;
		this.generatedIdCount_[parentElementId] = (this.generatedIdCount_[parentElementId] || 0) + 1;
		return parentElementId + '-s' + this.generatedIdCount_[parentElementId];
	}

	/**
	 * Gets the html that should be used to build this component's main element with
	 * some content.
	 * @param {string} content
	 * @return {string}
	 */
	getComponentHtml(content) {
		return this.wrapContentIfNecessary(content, this.id, this.constructor.ELEMENT_TAG_NAME_MERGED);
	}

	/**
	 * Gets the content that should be rendered in the component's main element.
	 * Should be implemented by subclasses.
	 * @return {Object|string} The content to be rendered. If the content is a
	 *   string, surfaces can be represented by placeholders in the format specified
	 *   by Component.SURFACE_REGEX. Also, if the string content's main wrapper has
	 *   the component's id, then it will be used to render the main element tag.
	 */
	getElementContent() {}

	/**
	 * Internal function for getting the component element's content. Stores the
	 * result in a variable so it can be accessed later without building it again.
	 * @return {Object|string}
	 * @protected
	 */
	getElementContent_() {
		this.elementContent_ = this.elementContent_ || this.getElementContent();
		return this.elementContent_;
	}

	/**
	 * Calls `getElementContent` and replaces all placeholders in the returned content.
	 * @return {string} The content with all placeholders already replaced.
	 */
	getElementExtendedContent() {
		return this.replaceSurfacePlaceholders_(this.getElementContent_());
	}

	/**
	 * Gets surfaces that got modified by the specified attributes changes.
	 * @param {Object.<string, Object>} changes Object containing the attribute
	 *     name as key and an object with newVal and prevVal as value.
	 * @return {Object.<string, boolean>} Object containing modified surface ids
	 *     as key and true as value.
	 */
	getModifiedSurfacesFromChanges_(changes) {
		var surfaces = [];
		for (var attr in changes) {
			if (this.surfacesRenderAttrs_[attr]) {
				surfaces.push(this.surfacesRenderAttrs_[attr]);
			}
		}
		return object.mixin.apply(null, surfaces);
	}

	/**
	 * Same as `getSurfaceHtml`, but only called for non component surfaces.
	 * @param {string} surfaceElementId
	 * @param {string} content
	 * @return {string}
	 */
	getNonComponentSurfaceHtml(surfaceElementId, content) {
		return this.wrapContentIfNecessary(content, surfaceElementId, this.constructor.SURFACE_TAG_NAME_MERGED);
	}

	/**
	 * Gets surface configuration object. If surface is not registered returns
	 * null.
	 * @param {string} surfaceId The surface id or its element id.
	 * @return {Object} The surface configuration object.
	 */
	getSurface(surfaceId) {
		var surface = Component.surfacesCollector.getSurface(this.getSurfaceElementId_(surfaceId));
		return surface ? surface : Component.surfacesCollector.getSurface(surfaceId);
	}

	/**
	 * Gets the content for the requested surface. Should be implemented by subclasses.
	 * @param {string} surfaceId The surface id.
	 * @param {string} surfaceElementId The surface element id
	 * @return {Object|string} The content to be rendered. If the content is a
	 *   string, surfaces can be represented by placeholders in the format specified
	 *   by Component.SURFACE_REGEX.
	 */
	getSurfaceContent() {}

	/**
	 * Gets the content for the requested surface. By default this just calls
	 * `getSurfaceContent`, but can be overriden to add more behavior (check
	 * `SoyComponent` for an example).
	 * @param {string} surfaceElementId The surface element id.
	 * @return {Object|string} The content to be rendered.
	 * @protected
	 */
	getSurfaceContent_(surfaceElementId) {
		var surface = this.getSurface(surfaceElementId);
		if (surface.componentName) {
			var component = ComponentCollector.components[surfaceElementId];
			if (component.wasRendered) {
				return '';
			} else {
				return component.getElementExtendedContent();
			}
		} else {
			return this.getSurfaceContent(this.getSurfaceId_(surfaceElementId, surface), surfaceElementId);
		}
	}

	/**
	 * Queries from the document or creates an element for the surface. Surface
	 * elements have its surface id namespaced to the component id, e.g. for a
	 * component with id `gallery` and a surface with id `pictures` the surface
	 * element will be represented by the id `gallery-pictures`. Surface
	 * elements must also be appended to the component element.
	 * @param {string} surfaceId The surface id.
	 * @return {Element} The surface element or null if surface not registered.
	 */
	getSurfaceElement(surfaceId) {
		var surface = this.getSurface(surfaceId);
		if (!surface) {
			return null;
		}
		if (!surface.element) {
			if (surface.componentName) {
				var component = ComponentCollector.components[surfaceId];
				if (component) {
					surface.element = component.element;
				}
			} else {
				var surfaceElementId = this.getSurfaceElementId_(surfaceId, surface);
				surface.element = this.findElementById_(surfaceElementId) ||
					this.createSurfaceElement_(surfaceElementId);
			}
		}
		return surface.element;
	}

	/**
	 * Adds the component id as the prefix of the given surface id if necessary.
	 * @param {string} surfaceId
	 * @param {Object=} opt_surface The surface data.
	 * @return {string}
	 */
	getSurfaceElementId_(surfaceId, opt_surface) {
		var surface = opt_surface || {};
		if (surface.surfaceElementId) {
			return surface.surfaceElementId;
		} else if (surface.componentName || this.hasComponentPrefix_(surfaceId)) {
			return surfaceId;
		} else {
			return this.prefixSurfaceId_(surfaceId);
		}
	}

	/**
	 * Gets the html that should be used to build a surface's main element with its
	 * content.
	 * @param {string} surfaceElementId
	 * @param {string} content
	 * @return {string}
	 */
	getSurfaceHtml(surfaceElementId, content) {
		var surface = this.getSurface(surfaceElementId);
		if (surface.componentName) {
			return ComponentCollector.components[surfaceElementId].getComponentHtml(content);
		} else {
			return this.getNonComponentSurfaceHtml(surfaceElementId, content);
		}
	}

	/**
	 * Gets the surface id for the given surface element id
	 * @param {string} surfaceElementId
	 * @param {!Object} surface
	 * @return {string}
	 * @protected
	 */
	getSurfaceId_(surfaceElementId, surface) {
		if (surface.componentName || !this.hasComponentPrefix_(surfaceElementId)) {
			return surfaceElementId;
		} else {
			return surfaceElementId.substr(this.id.length + 1);
		}
	}

	/**
	 * A map of surface ids to the respective surface object.
	 * @return {!Object}
	 */
	getSurfaces() {
		var surfaces = {};
		Object.keys(this.surfaceIds_).forEach(function(surfaceElementId) {
			var surface = Component.surfacesCollector.getSurface(surfaceElementId);
			surfaces[this.getSurfaceId_(surfaceElementId, surface)] = surface;
		}.bind(this));
		return surfaces;
	}

	/**
	 * Handles attributes batch changes. Responsible for surface mutations and
	 * attributes synchronization.
	 * @param {Event} event
	 * @protected
	 */
	handleAttributesChanges_(event) {
		if (this.inDocument) {
			this.renderSurfacesContent_(this.getModifiedSurfacesFromChanges_(event.changes));
		}
		this.syncAttrsFromChanges_(event.changes);
	}

	/**
	 * Checks if the given surface id has this component's prefix.
	 * @param {string} surfaceId
	 * @return {boolean}
	 * @protected
	 */
	hasComponentPrefix_(surfaceId) {
		return surfaceId.substr(0, this.id.length + 1) === this.id + '-';
	}

	/**
	 * Fired when the `events` attribute value is changed.
	 * @param {!Object} event
	 * @protected
	 */
	onEventsChanged_(event) {
		this.eventsAttrHandler_.removeAllListeners();
		this.addListenersFromObj_(event.newVal);
	}

	/**
	 * Makes an unique id for the component.
	 * @return {string} Unique id.
	 * @protected
	 */
	makeId_() {
		return 'metal_c_' + core.getUid(this);
	}

	/**
	 * Merges an array of values for the ELEMENT_CLASSES property into a single object.
	 * @param {!Array.<string>} values The values to be merged.
	 * @return {!string} The merged value.
	 * @protected
	 */
	mergeElementClasses_(values) {
		var marked = {};
		return values.filter(function(val) {
			if (!val || marked[val]) {
				return false;
			} else {
				marked[val] = true;
				return true;
			}
		}).join(' ');
	}

	/**
	 * Merges an array of objects into a single object. Used by the SURFACES static
	 * variable.
	 * @param {!Array} values The values to be merged.
	 * @return {!Object} The merged value.
	 * @protected
	 */
	mergeObjects_(values) {
		return object.mixin.apply(null, [{}].concat(values.reverse()));
	}

	/**
	 * Prefixes the given surface id with this component's id.
	 * @param {string} surfaceId
	 * @return {string}
	 * @protected
	 */
	prefixSurfaceId_(surfaceId) {
		return this.id + '-' + surfaceId;
	}

	/**
	 * Unregisters a surface and removes its element from the DOM.
	 * @param {string} surfaceId The surface id.
	 * @chainable
	 */
	removeSurface(surfaceId) {
		var el = this.getSurfaceElement(surfaceId);
		if (el && el.parentNode) {
			el.parentNode.removeChild(el);
		}
		var surfaceElementId = this.getSurfaceElementId_(surfaceId, this.getSurface(surfaceId));
		Component.surfacesCollector.removeSurface(surfaceElementId);
		this.surfaceIds_[surfaceElementId] = false;
		return this;
	}

	/**
	 * Lifecycle. Renders the component into the DOM. Render phase replaces
	 * decorate phase, without progressive enhancement support.
	 *
	 * Render Lifecycle:
	 *   render - Decorate is manually called.
	 *   renderInternal - Internal implementation for rendering happens.
	 *   render surfaces - All surfaces content are rendered.
	 *   attribute synchronization - All synchronization methods are called.
	 *   attach - Attach Lifecycle is called.
	 *
	 * @param {(string|Element)=} opt_parentElement Optional parent element
	 *     to render the component.
	 * @param {(string|Element)=} opt_siblingElement Optional sibling element
	 *     to render the component before it. Relevant when the component needs
	 *     to be rendered before an existing element in the DOM, e.g.
	 *     `component.render(null, existingElement)`.
	 * @chainable
	 */
	render(opt_parentElement, opt_siblingElement) {
		if (this.wasRendered) {
			throw new Error(Component.Error.ALREADY_RENDERED);
		}

		this.renderInternal();

		this.renderSurfacesContent_(this.surfaceIds_);

		this.attachInlineListeners_();
		this.syncAttrs_();

		this.attach(opt_parentElement, opt_siblingElement);

		this.wasRendered = true;

		return this;
	}

	/**
	 * Renders this component as a subcomponent, meaning that no actual rendering is
	 * needed since it was already rendered by the parent component. This just handles
	 * other logics from the rendering lifecycle, like attaching event listeners.
	 */
	renderAsSubComponent() {
		this.attachInlineListeners_();
		this.syncAttrs_();
		this.attach();
		this.wasRendered = true;
	}

	/**
	 * Renders a surface that holds a component.
	 * @param {string} surfaceElementId
	 * @param {(Object|string)?} opt_content The content to be rendered.
	 * @protected
	 */
	renderComponentSurface_(surfaceElementId, opt_content) {
		var component = ComponentCollector.components[surfaceElementId];
		if (component.wasRendered) {
			var surface = this.getSurface(surfaceElementId);
			Component.componentsCollector.updateComponent(surfaceElementId, surface.componentData);
		} else if (opt_content) {
			var element = component.element;
			if (dom.isEmpty(element)) {
				// If we have the rendered content for this component, but it hasn't
				// been rendered in its element yet, we render it manually here. That
				// can happen if the subcomponent's element is set before the parent
				// element renders its content.
				dom.append(element, opt_content);
			}
			if (this.decorating_) {
				component.decorateAsSubComponent();
			} else {
				component.renderAsSubComponent();
			}
		} else {
			component.render();
		}
	}

	/**
	 * Renders the given content in the component's element.
	 * @param {string} content The content to be rendered.
	 * @protected
	 */
	renderContent_(content) {
		var element = this.element;
		var newElement;

		if (core.isString(content)) {
			content = dom.buildFragment(content);
			if (content.childNodes[0].id === this.id) {
				newElement = content.childNodes[0];
			}
		} else if (content.id === this.id) {
			newElement = content;
		}

		if (newElement) {
			this.updateElementAttributes_(element, newElement);
			content = newElement.childNodes;
		}
		dom.append(element, content);
	}

	/**
	 * Renders the component element into the DOM.
	 * @param {(string|Element)=} opt_parentElement Optional parent element
	 *     to render the component.
	 * @param {(string|Element)=} opt_siblingElement Optional sibling element
	 *     to render the component before it. Relevant when the component needs
	 *     to be rendered before an existing element in the DOM, e.g.
	 *     `component.render(null, existingElement)`.
	 * @protected
	 */
	renderElement_(opt_parentElement, opt_siblingElement) {
		var element = this.element;
		element.id = this.id;
		if (opt_siblingElement || !element.parentNode) {
			var parent = dom.toElement(opt_parentElement) || this.DEFAULT_ELEMENT_PARENT;
			parent.insertBefore(element, dom.toElement(opt_siblingElement));
		}
	}

	/**
	 * Lifecycle. Internal implementation for rendering. Any extra operation
	 * necessary to prepare the component DOM must be implemented in this phase.
	 */
	renderInternal() {
		var content = this.getElementExtendedContent();
		if (content) {
			this.renderContent_(content);
		}
	}

	/**
	 * Renders the contents of all the surface placeholders found in the given content.
	 * @param {string} content
	 * @param {string} surfaceElementId The id of surface element the content is from.
	 * @protected
	 */
	renderPlaceholderSurfaceContents_(content, surfaceElementId) {
		var instance = this;
		content.replace(Component.SURFACE_REGEX, function(match, id) {
			instance.renderSurfaceContent(instance.createPlaceholderSurface_(id, surfaceElementId));
			return match;
		});
	}

	/**
	 * Render content into a surface. If the specified content is the same of
	 * the current surface content, nothing happens. If the surface cache state
	 * is not initialized or the content is not eligible for cache or content is
	 * different, the surfaces re-renders. It's not recommended to use this
	 * method directly since surface content can be provided by
	 * `getSurfaceContent(surfaceElementId)`.
	 * @param {string} surfaceElementId The surface id.
	 * @param {(Object|string)?} opt_content The content to be rendered.
	 * @param {string?} opt_cacheContent The content that should be cached for
	 *   this surface. If none is given, the rendered content will be used for this.
	 */
	renderSurfaceContent(surfaceElementId, opt_content, opt_cacheContent) {
		var surface = this.getSurface(surfaceElementId);
		if (surface.componentName) {
			this.renderComponentSurface_(surfaceElementId, opt_content);
			return;
		}

		var content = opt_content || this.getSurfaceContent_(surfaceElementId);
		if (core.isDefAndNotNull(content)) {
			if (this.decorating_) {
				this.cacheSurfaceContent(
					surfaceElementId,
					html.compress(this.getSurfaceElement(surfaceElementId).outerHTML)
				);
			}
			var previousCacheState = surface.cacheState;
			var cacheContent = opt_cacheContent || content;

			// We cache the entire original content first when decorating so we can compare
			// with the full content we got from the dom. After comparing, we cache the correct
			// value so updates can work as expected for this surface.
			this.cacheSurfaceContent(surfaceElementId, this.decorating_ ? content : cacheContent);
			var cacheHit = this.compareCacheStates_(surface.cacheState, previousCacheState);
			if (this.decorating_) {
				this.cacheSurfaceContent(surfaceElementId, cacheContent);
			}

			if (cacheHit) {
				if (this.decorating_) {
					this.eventsCollector_.attachListeners(cacheContent, surfaceElementId);
				}
				this.renderPlaceholderSurfaceContents_(content, surfaceElementId);
			} else {
				this.eventsCollector_.attachListeners(cacheContent, surfaceElementId);
				this.replaceSurfaceContent_(surfaceElementId, content);
			}
		}
	}

	/**
	 * Renders all surfaces contents ignoring the cache.
	 * @param {Object.<string, Object=>} surfaces Object map where the key is
	 *     the surface id and value the optional surface configuration.
	 * @protected
	 */
	renderSurfacesContent_(surfaces) {
		this.generatedIdCount_ = {};
		for (var surfaceElementId in surfaces) {
			if (!this.getSurface(surfaceElementId).handled) {
				this.renderSurfaceContent(surfaceElementId);
			}
		}
		if (this.wasRendered) {
			this.updatePlaceholderSurfaces_();
			this.eventsCollector_.detachUnusedListeners();
		}
	}

	/**
	 * Replaces the content of a surface with a new one.
	 * @param {string} surfaceElementId The surface id.
	 * @param {Element|string} content The content to be rendered.
	 * @protected
	 */
	replaceSurfaceContent_(surfaceElementId, content) {
		var el = this.getSurfaceElement(surfaceElementId);
		content = this.replaceSurfacePlaceholders_(content, surfaceElementId);
		if (this.checkHasElementTag_(content, surfaceElementId)) {
			var surface = this.getSurface(surfaceElementId);
			surface.element = content;
			if (core.isString(content)) {
				surface.element = dom.buildFragment(content).childNodes[0];
			}
			if (el.parentNode) {
				dom.replace(el, surface.element);
			}
		} else {
			dom.removeChildren(el);
			dom.append(el, content);
		}
	}

	/**
	 * Replaces the given content's surface placeholders with their real contents.
	 * @param {string|Element} content
	 * @param {string=} opt_surfaceElementId The id of the surface element that contains
	 *   the given content, or undefined if the content is from the main element.
	 * @return {string} The final string with replaced placeholders.
	 * @protected
	 */
	replaceSurfacePlaceholders_(content, opt_surfaceElementId) {
		if (!core.isString(content)) {
			return content;
		}

		var instance = this;
		return content.replace(Component.SURFACE_REGEX, function(match, id) {
			// Surfaces should already have been created before being rendered so they can be
			// accessed from their getSurfaceContent calls.
			id = instance.createPlaceholderSurface_(id, opt_surfaceElementId);
			instance.getSurface(id).handled = true;

			var surfaceContent = instance.getSurfaceContent_(id);
			var surfaceHtml = instance.getSurfaceHtml(id, surfaceContent);
			var expandedHtml = instance.replaceSurfacePlaceholders_(surfaceHtml, id);
			instance.collectedSurfaces_.push({
				cacheContent: surfaceContent,
				content: expandedHtml,
				surfaceElementId: id
			});

			return expandedHtml;
		});
	}

	/**
	 * Setter logic for element attribute.
	 * @param {string|Element} val
	 * @return {Element}
	 * @protected
	 */
	setterElementFn_(val) {
		var element = dom.toElement(val);
		if (!element) {
			element = this.valueElementFn_();
		}
		return element;
	}

	/**
	 * Attribute synchronization logic for the `elementClasses` attribute.
	 * @param {string} newVal
	 * @param {string} prevVal
	 */
	syncElementClasses(newVal, prevVal) {
		var classesToAdd = this.constructor.ELEMENT_CLASSES_MERGED;
		if (newVal) {
			classesToAdd = classesToAdd + ' ' + newVal;
		}
		if (prevVal) {
			dom.removeClasses(this.element, prevVal);
		}
		dom.addClasses(this.element, classesToAdd);
	}

	/**
	 * Attribute synchronization logic for `visible` attribute.
	 * Updates the element's display value according to its visibility.
	 * @param {boolean} newVal
	 */
	syncVisible(newVal) {
		this.element.style.display = newVal ? '' : 'none';
	}

	/**
	 * Sets the attributes from the second element to the first element.
	 * @param {!Element} element
	 * @param {!Element} newElement
	 * @protected
	 */
	updateElementAttributes_(element, newElement) {
		var attrs = newElement.attributes;
		for (var i = 0; i < attrs.length; i++) {
			// The "id" and "class" html attributes are already synced via the "id"
			// and "elementClasses" component attributes, respectively.
			if (attrs[i].name !== 'id' && attrs[i].name !== 'class') {
				element.setAttribute(attrs[i].name, attrs[i].value);
			}
		}

		if (element.tagName !== newElement.tagName) {
			console.error(
				'The component named "' + this.constructor.NAME + '" tried to change the component ' +
				'element\'s tag name, which is not allowed. Make sure to always return the same tag ' +
				'name for the component element on getElementContent, as well as to set the static ' +
				'variable ELEMENT_TAG_NAME to the chosen value.'
			);
		}
	}

	/**
	 * Updates a surface after it has been rendered through placeholders.
	 * @param {!{content: string, cacheContent: string, surfaceElementId: string}} collectedData
	 *   Data about the collected surface. Should have the surface's id, content and the
	 *   content that should be cached for it.
	 * @protected
	 */
	updatePlaceholderSurface_(collectedData) {
		var surfaceElementId = collectedData.surfaceElementId;
		var surface = this.getSurface(surfaceElementId);
		if (surface.componentName) {
			// Elements of component surfaces are unchangeable, so we need to replace the
			// rendered element with the component's.
			dom.replace(this.findElementById_(surfaceElementId), this.getSurfaceElement(surfaceElementId));
		}

		if (this.decorating_ || surface.componentName) {
			// Component surfaces need to be handled in case some internal details have changed.
			// Also, if this component is being decorated, it needs to go through the regular flow
			// to check if the cache matches.
			this.renderSurfaceContent(surfaceElementId, collectedData.content, collectedData.cacheContent);
		} else {
			// This surface's element has either changed or never been created yet. Let's just
			// reset it to null, so it can be fetched from the dom again when necessary. Also,
			// since there's no need to do cache checks or rerender, let's just attach its
			// listeners and cache its content manually.
			surface.element = null;
			this.cacheSurfaceContent(surfaceElementId, collectedData.cacheContent);
			this.eventsCollector_.attachListeners(collectedData.cacheContent, surfaceElementId);
		}
	}

	/**
	 * Updates all collected surfaces.
	 * @protected
	 */
	updatePlaceholderSurfaces_() {
		for (var i = this.collectedSurfaces_.length - 1; i >= 0; i--) {
			this.updatePlaceholderSurface_(this.collectedSurfaces_[i]);
			this.getSurface(this.collectedSurfaces_[i].surfaceElementId).handled = false;
		}
		this.collectedSurfaces_ = [];
	}

	/**
	 * Validator logic for element attribute.
	 * @param {string|Element} val
	 * @return {boolean} True if val is a valid element.
	 * @protected
	 */
	validatorElementFn_(val) {
		return core.isElement(val) || core.isString(val);
	}

	/**
	 * Validator logic for elementClasses attribute.
	 * @param {string} val
	 * @return {boolean} True if val is a valid element classes.
	 * @protected
	 */
	validatorElementClassesFn_(val) {
		return core.isString(val);
	}

	/**
	 * Validator logic for the `events` attribute.
	 * @param {Object} val
	 * @return {boolean}
	 * @protected
	 */
	validatorEventsFn_(val) {
		return !core.isDefAndNotNull(val) || core.isObject(val);
	}

	/**
	 * Validator logic for the `id` attribute.
	 * @param {string} val
	 * @return {boolean} True if val is a valid id.
	 * @protected
	 */
	validatorIdFn_(val) {
		return core.isString(val);
	}

	/**
	 * Provides the default value for element attribute.
	 * @return {Element} The element.
	 * @protected
	 */
	valueElementFn_() {
		return document.createElement(this.constructor.ELEMENT_TAG_NAME_MERGED);
	}

	/**
	 * Provides the default value for id attribute.
	 * @return {string} The id.
	 * @protected
	 */
	valueIdFn_() {
		var element = this.element;
		return (element && element.id) ? element.id : this.makeId_();
	}

	/**
	 * Wraps the content with the given tag, unless the content already has an element with the
	 * correct id.
	 * @param {string} content
	 * @param {string} id
	 * @param {string} tag
	 * @return {string}
	 * @protected
	 */
	wrapContentIfNecessary(content, id, tag) {
		if (!this.checkHasElementTag_(content, id)) {
			content = '<' + tag + ' id="' + id + '">' + content + '</' + tag + '>';
		}
		return content;
	}
}

/**
 * Helper responsible for extracting components from strings and config data.
 * @type {!ComponentCollector}
 * @protected
 * @static
 */
Component.componentsCollector = new ComponentCollector();

/**
 * Helper responsible for temporarily holding surface data.
 * @type {!SurfaceCollector}
 * @protected
 * @static
 */
Component.surfacesCollector = new SurfaceCollector();

/**
 * Component attributes definition.
 * @type {Object}
 * @static
 */
Component.ATTRS = {
	/**
	 * Component element bounding box.
	 * @type {Element}
	 * @writeOnce
	 */
	element: {
		setter: 'setterElementFn_',
		validator: 'validatorElementFn_',
		valueFn: 'valueElementFn_',
		writeOnce: true
	},

	/**
	 * CSS classes to be applied to the element.
	 * @type {Array.<string>}
	 */
	elementClasses: {
		validator: 'validatorElementClassesFn_'
	},

	/**
	 * Listeners that should be attached to this component. Should be provided as an object,
	 * where the keys are event names and the values are the listener functions (or function
	 * names).
	 * @type {Object<string, (function()|string|{selector: string, fn: function()|string})>}
	 */
	events: {
		validator: 'validatorEventsFn_',
		value: null
	},

	/**
	 * Component element id. If not specified will be generated.
	 * @type {string}
	 * @writeOnce
	 */
	id: {
		validator: 'validatorIdFn_',
		valueFn: 'valueIdFn_',
		writeOnce: true
	},

	/**
	 * Indicates if the component is visible or not.
	 * @type {boolean}
	 */
	visible: {
		validator: core.isBoolean,
		value: true
	}
};

/**
 * CSS classes to be applied to the element.
 * @type {string}
 * @protected
 * @static
 */
Component.ELEMENT_CLASSES = 'component';

/**
 * Element tag name is a string that specifies the type of element to be
 * created. The nodeName of the created element is initialized with the
 * value of tag name.
 * @type {string}
 * @default div
 * @protected
 * @static
 */
Component.ELEMENT_TAG_NAME = 'div';

/**
 * The regex used to search for surface placeholders.
 * @type {RegExp}
 * @static
 */
Component.SURFACE_REGEX = /\%\%\%\%~s(?:-([^~:]+))?~\%\%\%\%/g;

/**
 * Surface tag name is a string that specifies the type of element to be
 * created for the surfaces. The nodeName of the created element is
 * initialized with the value of tag name.
 * @type {string}
 * @default div
 * @protected
 * @static
 */
Component.SURFACE_TAG_NAME = 'div';

/**
 * Cache states for the component.
 * @enum {string}
 */
Component.Cache = {
	/**
	 * Cache is not allowed for this state.
	 */
	NOT_CACHEABLE: -1,

	/**
	 * Cache not initialized.
	 */
	NOT_INITIALIZED: -2
};

/**
 * Errors thrown by the component.
 * @enum {string}
 */
Component.Error = {
	/**
	 * Error when the component is already rendered and another render attempt
	 * is made.
	 */
	ALREADY_RENDERED: 'Component already rendered'
};

/**
 * A list with attribute names that will automatically be rejected as invalid.
 * @type {!Array<string>}
 */
Component.INVALID_ATTRS = ['components', 'elementContent'];

export default Component;
