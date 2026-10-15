<?php
/**
 * SEO title/description for Yoast SEO, Rank Math and All in One SEO, with a change log
 * so every change can be rolled back.
 *
 * Storage used by each plugin (verify on a staging site before relying on it — see readme.txt):
 *  - Yoast SEO:  post meta _yoast_wpseo_title, _yoast_wpseo_metadesc   (UNVERIFIED against Yoast docs)
 *  - Rank Math:  post meta rank_math_title, rank_math_description        (UNVERIFIED against Rank Math docs)
 *  - AIOSEO:     its own table via \AIOSEO\Plugin\Common\Models\Post     (UNVERIFIED API; AIOSEO documents REST writes via aioseo_meta_data)
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class JAT_Seo {
	const CHANGES_OPTION = 'jat_connector_seo_changes';
	const MAX_CHANGES    = 500;

	public static function detect() {
		if ( defined( 'WPSEO_VERSION' ) ) {
			return 'yoast';
		}
		if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
			return 'rankmath';
		}
		if ( defined( 'AIOSEO_VERSION' ) || function_exists( 'aioseo' ) ) {
			return 'aioseo';
		}
		return 'none';
	}

	public static function get( $post_id ) {
		switch ( self::detect() ) {
			case 'yoast':
				return array(
					'title'       => (string) get_post_meta( $post_id, '_yoast_wpseo_title', true ),
					'description' => (string) get_post_meta( $post_id, '_yoast_wpseo_metadesc', true ),
				);
			case 'rankmath':
				return array(
					'title'       => (string) get_post_meta( $post_id, 'rank_math_title', true ),
					'description' => (string) get_post_meta( $post_id, 'rank_math_description', true ),
				);
			case 'aioseo':
				$p = self::aioseo_post( $post_id );
				return array(
					'title'       => $p ? (string) $p->title : '',
					'description' => $p ? (string) $p->description : '',
				);
		}
		return array( 'title' => '', 'description' => '' );
	}

	private static function set( $post_id, $fields ) {
		$plugin = self::detect();
		if ( 'yoast' === $plugin || 'rankmath' === $plugin ) {
			$keys = 'yoast' === $plugin
				? array( 'title' => '_yoast_wpseo_title', 'description' => '_yoast_wpseo_metadesc' )
				: array( 'title' => 'rank_math_title', 'description' => 'rank_math_description' );
			foreach ( $fields as $k => $v ) {
				if ( '' === $v ) {
					delete_post_meta( $post_id, $keys[ $k ] );
				} else {
					update_post_meta( $post_id, $keys[ $k ], $v );
				}
			}
			clean_post_cache( $post_id );
			return true;
		}
		if ( 'aioseo' === $plugin ) {
			$p = self::aioseo_post( $post_id );
			if ( ! $p ) {
				return false;
			}
			foreach ( $fields as $k => $v ) {
				$p->$k = $v;
			}
			$p->save();
			return true;
		}
		return false;
	}

	private static function aioseo_post( $post_id ) {
		if ( ! class_exists( '\AIOSEO\Plugin\Common\Models\Post' ) ) {
			return null;
		}
		$p = \AIOSEO\Plugin\Common\Models\Post::getPost( $post_id );
		if ( $p && ! $p->exists() ) {
			$p->post_id = $post_id;
		}
		return $p;
	}

	/** @return array|WP_Error */
	public static function update( $post_id, $change_id, $fields ) {
		$plugin = self::detect();
		if ( 'none' === $plugin ) {
			return new WP_Error( 'jat_no_seo_plugin', 'No supported SEO plugin (Yoast SEO, Rank Math, AIOSEO) is active.', array( 'status' => 409 ) );
		}
		$changes = get_option( self::CHANGES_OPTION, array() );
		if ( isset( $changes[ $change_id ] ) ) {
			// Idempotent: the same change applied twice returns the first result.
			return $changes[ $change_id ];
		}
		$before = self::get( $post_id );
		$clean  = array();
		foreach ( array( 'title', 'description' ) as $k ) {
			if ( isset( $fields[ $k ] ) ) {
				$clean[ $k ] = sanitize_text_field( $fields[ $k ] );
			}
		}
		if ( ! self::set( $post_id, $clean ) ) {
			return new WP_Error( 'jat_seo_write_failed', 'The SEO plugin did not accept the change.', array( 'status' => 500 ) );
		}
		$record                = array(
			'changeId' => $change_id,
			'post_id'  => $post_id,
			'plugin'   => $plugin,
			'before'   => array_intersect_key( $before, $clean ),
			'after'    => $clean,
			'at'       => gmdate( 'c' ),
			'user'     => get_current_user_id(),
		);
		$changes[ $change_id ] = $record;
		if ( count( $changes ) > self::MAX_CHANGES ) {
			$changes = array_slice( $changes, -self::MAX_CHANGES, null, true );
		}
		update_option( self::CHANGES_OPTION, $changes, false );
		return $record;
	}

	/** @return array|WP_Error */
	public static function rollback( $change_id ) {
		$changes = get_option( self::CHANGES_OPTION, array() );
		if ( ! isset( $changes[ $change_id ] ) ) {
			return new WP_Error( 'jat_change_not_found', 'Unknown change id.', array( 'status' => 404 ) );
		}
		$c = $changes[ $change_id ];
		if ( ! current_user_can( 'edit_post', $c['post_id'] ) ) {
			return new WP_Error( 'jat_forbidden', 'Not allowed to edit this post.', array( 'status' => 403 ) );
		}
		if ( ! empty( $c['rolled_back_at'] ) ) {
			return array( 'rolled_back' => true, 'post_id' => $c['post_id'], 'restored' => $c['before'] );
		}
		if ( ! self::set( $c['post_id'], $c['before'] ) ) {
			return new WP_Error( 'jat_seo_write_failed', 'The SEO plugin did not accept the rollback.', array( 'status' => 500 ) );
		}
		$changes[ $change_id ]['rolled_back_at'] = gmdate( 'c' );
		update_option( self::CHANGES_OPTION, $changes, false );
		return array( 'rolled_back' => true, 'post_id' => $c['post_id'], 'restored' => $c['before'] );
	}
}
