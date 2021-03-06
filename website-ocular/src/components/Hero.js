import React, {Component} from 'react';
import {Link} from 'react-router-dom';
import Stats from 'stats.js';

import {InstancingDemo} from 'react-demos';

class Hero extends Component {

  componentDidMount() {
    this._stats = new Stats();
    this._stats.showPanel(0);
    if (this.refs.fps) {
      this.refs.fps.appendChild(this._stats.dom);
    }

    const calcFPS = () => {
      this._stats.begin();
      this._stats.end();
      this._animateRef = window.requestAnimationFrame(calcFPS);
    };

    this._animateRef = window.requestAnimationFrame(calcFPS);
  }

  componentWillUnmount() {
    window.onresize = null;
    window.cancelAnimationFrame(this._animateRef);
  }

  render() {
    return (
      <section ref="banner" className="banner">
        <div className="f hero">
          <InstancingDemo />
        </div>
        <div className="container">
          <h1>luma.gl</h1>
          <p>A WebGL2-Powered Framework for GPU-based Visualization and Computation</p>
          <Link to="/docs" className="btn">
            {'GET STARTED'}
          </Link>
        </div>
        <div ref="fps" className="fps" />
      </section>
    );
  }
}

export default Hero;
