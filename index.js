#!/usr/bin/env node

const debug = require('debug')('graph-config-template')
const parse = require('dotparser')

const createNodeStatement = require('./create-node-statement');
const createRelationshipStatement = require('./create-relationship-statement')

const identity = v => v
const exists = v => !!v
const property = (prop, defaultValue) => v => v[prop] || defaultValue
const flatten = (arr = []) => arr.reduce((acc, curr) => acc.concat(curr), [])

const arity = fn => fn.length || 0
function curry (fn) {
  const len = arity(fn)

  let invokedArgs = []
  function curriedFn (...args) {
    invokedArgs = invokedArgs.concat(args)
    if (invokedArgs.length >= len) {
      return fn(...invokedArgs)
    } else {
      return curriedFn
    }
  }
  curriedFn.displayName = fn.displayName || fn.name || 'AnonymousFunction'

  return curriedFn
}

const GENERIC_NODE_TYPE = 'Node'
const GENERIC_RELATIONSHIP_TYPE = 'Relationship'
const DEFAULT_ID_NAME = 'id'

const using = curry((label, fn) => {
  const transform = (props = {}) => Array.isArray(props[label]) ? props[label].map(fn) : fn(props[label])
  transform.label = label
  return transform
})

const DEFAULT_GRAPH_CONFIG = {
  [GENERIC_NODE_TYPE]: createNodeStatement,
  [GENERIC_RELATIONSHIP_TYPE]: createRelationshipStatement
}

function toAttributes (obj) {
  if (!obj) {
    return null
  }

  if (typeof obj === 'string') {
    if (obj.indexOf('=') === -1) {
      throw new Error('Strings passed into toAttributes() must contain an equals sign. e.g. idName=id')
    }
    return obj
  } else if (Array.isArray(obj)) {
    return obj.map(kv => Array.isArray(kv) ? `${kv[0]}=${kv[1]}` : `${kv.key}=${kv.value}`).join(',')
  } else if (typeof obj === 'object') {
    return Object.keys(obj).reduce((acc, curr) => {
      if (typeof obj[curr] === 'undefined') {
        throw new Error(`The key '${curr}' could not be found within the values passed in`)
      }
      acc.push(`${curr}=${obj[curr]}`)
      return acc
    }, []).join(',')
  }
}

const zipToString = (strs, attributes) => {
  return strs.map((str, idx) => [ str, attributes[idx] ].filter(exists).join('')).join('')
}

const createLabelToFunctionMap = (fns = []) => {
  const labelToFunctionMap = {}

  fns.forEach(fn => {
    if (!fn.label) {
      throw new Error('Functions passed into a graph must be wrapped with using() and given a label.')
    }
    labelToFunctionMap[fn.label] = fn
  })

  return labelToFunctionMap
}

function createDescription (strs = [], interpolatableValues = []) {
  const attributes = interpolatableValues.map(toAttributes)
  const description = zipToString(strs, attributes)
  return description
}

function createToStatements ({
  Node: createNode,
  Relationship: createRelationship
}) {
  const isNodeStatement = c => c.type === 'node_stmt'
  const isRelationshipStatement = c => c.type === 'edge_stmt'

  const getNodeName = node => node.node_id.id
  const toLabel = node => {
    const labelAttr = (node.attr_list || []).find(attr => attr.id === 'label')
    if (labelAttr) {
      return labelAttr.eq
    } else if (node.node_id.id) {
      return node.node_id.id
    }

    return GENERIC_NODE_TYPE
  }
  const toIdName = node => {
    const idNameAttr = (node.attr_list || []).find(attr => attr.id === 'idName')
    if (idNameAttr) {
      return idNameAttr.eq
    }
    return DEFAULT_ID_NAME
  }
  const toProps = (node) =>
    (node.attr_list || []).reduce((acc, curr) => {
      if (curr.id !== 'idName') {
        acc[curr.id] = curr.eq
      }
      return acc
    }, {})

  return ({ graph, labelToFunctionMap = {}, values = {} }) => {
    // console.log(JSON.stringify(graph, null, 2))
    // console.log(labelToFunctionMap)
    // console.log(values)

    const children = graph.children || []
    const nodeDotStatements = children.filter(isNodeStatement)
    const relationshipDotStatements = children.filter(isRelationshipStatement)

    const nodeStatements = flatten(
      nodeDotStatements.map(ns => {
        const nodeName = getNodeName(ns)
        const defaultLabel = toLabel(ns)
        const idName = toIdName(ns)

        // TODO: rename labelToFunctionMap
        const transform = labelToFunctionMap[nodeName] || property(nodeName)
        const transformedValues = transform(values)
        if (Array.isArray(transformedValues)) {
          return transformedValues.map(tvs => {
            const label = tvs.label || defaultLabel
            return createNode({
              label,
              idName,
              props: Object.assign({}, toProps(ns), tvs)
            })
          })
        } else {
          const label = (transformedValues || {}).label || defaultLabel
          if (!transformedValues) {
            debug(`No node named ${nodeName} could be found within the values object`)
          }
          return transformedValues
            ? createNode({
              label,
              idName,
              props: Object.assign({}, toProps(ns), transformedValues)
            })
            : null
        }
      }).filter(exists)
    )
    // console.log(JSON.stringify(nodeStatements, null, 1))

    const edgeStatements = flatten(
      relationshipDotStatements.map(rs => {

        //console.log(rs)
        const nodes = rs.edge_list.map(e => e.id)
        // console.log(nodes)
        const props = toProps(rs)
        // console.log(props)

        const nodeToProps = nodes.map(nodeName => {
          const matchingNode = nodeDotStatements.find(nds => nds.node_id.id === nodeName)

          if (matchingNode) {
            const nodeName = getNodeName(matchingNode)
            const defaultLabel = toLabel(matchingNode)
            const idName = toIdName(matchingNode)

            const transform = labelToFunctionMap[nodeName] || property(nodeName)
            const transformedValues = transform(values)

            const props = toProps(matchingNode)

            return {
              nodeName,
              defaultLabel,
              idName,
              props: Array.isArray(transformedValues)
                ? transformedValues.map(tvs => Object.assign({}, props, tvs))
                : Object.assign({}, props, transformedValues)
            }
          }

          debug(`No node named ${nodeName} required by the relationship ${nodes.join(' -> ')} could be found within the values object`)
          return null
        }).filter(exists)

        console.log(JSON.stringify(nodeToProps, null, 2))
        if (nodeToProps.length < 2) {
          debug(`Found an invalid relationship ${nodes.join(' -> ')} with less than two nodes. This is possibly due to a node not existing within the values object.`)
          return;
        }

        // TODO: create relationships with a sliding window of two.

        // TODO: create Relationship:
        //       left (id, label, idName),
        //       right (id, label, idName),
        //       type (attribute of rel),
        //       direction (directionality of rel)
        // return {} // createRelationship({})
        // type should come from the relationship label
        // direction should come from the `dir` attribute
        //
        // TODO: Disable the array relationship support to begin with:
        //       What does it mean to create a relationship when the does related to it are arrays of nodes?
        //       nodeToProps.props can be an array now.
        //       Perhaps: one to many, or many to one okay, but not many to many?
      })
    )
    // console.log(JSON.stringify(edgeStatements, null, 1))

    return [].concat(nodeStatements, edgeStatements)
  }
}

function graphConfig (options = DEFAULT_GRAPH_CONFIG) {
  const toStatements = createToStatements(options)

  const toInterpolatableValuesAndFunctionMap = templateValues => {
    const labelToFunctionMap = createLabelToFunctionMap(
      templateValues.filter(v => typeof v === 'function')
    )
    const interpolatableValues = templateValues.filter(v => typeof v !== 'function')
    return {
      interpolatableValues,
      labelToFunctionMap
    }
  }

  const createSave = (strs, interpolatableValues, labelToFunctionMap, createDot = identity) => values => {
    const description = createDescription(strs, interpolatableValues)
    const dot = createDot(description)
    debug('created dot:', dot)
    return flatten(
      parse(dot).map(graph => toStatements({ graph, labelToFunctionMap, values }))
    )
  }

  function dot (strs, ...templateValues) {
    const { interpolatableValues, labelToFunctionMap } = toInterpolatableValuesAndFunctionMap(templateValues)
    const toDot = identity

    return createSave(strs, interpolatableValues, labelToFunctionMap, toDot)
  }

  function graph (strs, ...templateValues)  {
    const { interpolatableValues, labelToFunctionMap } = toInterpolatableValuesAndFunctionMap(templateValues)
    const toGraph = description => `graph { ${description} }`

    return createSave(strs, interpolatableValues, labelToFunctionMap, toGraph)
  }

  function digraph (strs, ...templateValues) {
    const { interpolatableValues, labelToFunctionMap } = toInterpolatableValuesAndFunctionMap(templateValues)
    const toDigraph = description => `digraph { ${description} }`

    return createSave(strs, interpolatableValues, labelToFunctionMap, toDigraph)
  }

  return {
    dot,
    graph,
    digraph
  }
}

// NOTE: labels on nodes and relationships: http://stackoverflow.com/a/6055235
const A_1 = { sides: 3 }
const A_2 = { sides: 5 }
const B = { sides: 5 }
const C = { sides: 8 }

const { digraph } = graphConfig();

// TODO: Create issue for 'Optionality':
//       How to optional create nodes or relationships?
//       Try with subgraphs - can they be passed in?
//       How to visualise optional node or relationships?
//       Can props function return a graph for optionality?
//       Exists predicate function takes in template? Etc

// TODO: Should still be parseable by dot -- will need to ignore variable interpolation.
// TODO: Think about how to display inline:
//       https://atom.io/packages/preview-inline
//       https://atom.io/packages/inline-markdown-images

// TODO: I want to clean the attributes of dot only stuff before sending them to neo4j.
// TODO: Learn meaning of each of these, just in case some are relevant.

const typeToLabel = using('C')(props => ({ label: props.type, id: props.id }))
const out = digraph`
  A [idName=aId,${A_1}];
  B [idName=bId,${B}]
  C [idName=id,${typeToLabel}];
  D [idName=id,${typeToLabel}];

  A -> B;
  B -> C -> D;
`;

// TODO: Get it to work if the nodes are not within the digraph - instead just relationships.
// TODO: Get it to work with no directionality (graph mode, etc.)

/*
TODO: Write some toAttributes tests.
console.log(toAttributes({ hey: 'there', 'you': 'ok' }))
console.log(toAttributes('hey=there,you=ok'))
console.log(toAttributes( [ [ 'hey', 'there' ], [ 'you', 'ok' ] ] ))
console.log(toAttributes( [ { key: 'hey', value: 'there' }, { key: 'you', value: 'ok' } ] ))
*/

const statements = out({
  A: { aId: 10 }, // [ { aId: 10 }, { aId: 15 }, { aId: 20 } ],
  B: { bId: 25 },
  C: { type: [ 'C', 'LABEL_OF_C' ], id: 100 },
  D: { type: [ 'D', 'LABEL_OF_D' ], id: 500 }
})

/*
console.log(
  JSON.stringify(
    statements,
    null,
    2
  )
);
*/

// How to represent connections between a node and its self:
/*
const selfConnected = digraph`
  opinion

  fact_1 [label="fact"]
  fact_2 [label="fact"]

  fact_1 -> fact_2
`
*/
// TODO: Write usage examples for imaginary implementation.

module.exports.toAttributes = toAttributes;
