<?php
/**
 * REST routes under /jat/v1. Every route requires:
 *  1. a logged-in user (WordPress Application Password over HTTPS),
 *  2. a valid JAT signature (shared secret, timestamp, single-use nonce),
 *  3. the WordPress capability for the specific action.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class JAT_Rest {
	const NS = 'jat/v1';

	public static function register() {
		register_rest_route(
			self::NS,
			'/health',
			array(
				'methods'             => 'GET',
				'callback'            => array( __CLASS__, 'health' ),
				'permission_callback' => self::guard( 'read' ),
			)
		);
		register_rest_route(
			self::NS,
			'/posts',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'create_post' ),
				'permission_callback' => self::guard( 'edit_posts' ),
				'args'                => array(
					'title'    => array( 'type' => 'string', 'required' => true, 'sanitize_callback' => 'sanitize_text_field' ),
					'content'  => array( 'type' => 'string', 'required' => true ),
					'excerpt'  => array( 'type' => 'string', 'required' => false, 'sanitize_callback' => 'sanitize_textarea_field' ),
					'status'   => array( 'type' => 'string', 'required' => true, 'enum' => array( 'draft', 'future' ) ),
					'date_gmt' => array( 'type' => 'string', 'required' => false ),
				),
			)
		);
		register_rest_route(
			self::NS,
			'/posts/(?P<id>\d+)/seo',
			array(
				array(
					'methods'             => 'GET',
					'callback'            => array( __CLASS__, 'get_seo' ),
					'permission_callback' => self::guard( 'edit_post' ),
				),
				array(
					'methods'             => 'POST',
					'callback'            => array( __CLASS__, 'update_seo' ),
					'permission_callback' => self::guard( 'edit_post' ),
				),
			)
		);
		register_rest_route(
			self::NS,
			'/changes/(?P<change_id>[A-Za-z0-9_-]{8,64})/rollback',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'rollback' ),
				'permission_callback' => self::guard( 'edit_posts' ),
			)
		);
	}

	/** Builds a permission callback: signature first, then the capability (per post where relevant). */
	private static function guard( $capability ) {
		return function ( WP_REST_Request $request ) use ( $capability ) {
			if ( ! is_user_logged_in() ) {
				return new WP_Error( 'jat_auth_required', 'Use an Application Password for the JAT Connector user.', array( 'status' => 401 ) );
			}
			$result = JAT_Signature::verify(
				(string) get_option( JAT_Settings::SECRET_OPTION, '' ),
				$request->get_method(),
				$request->get_route(),
				$request->get_header( 'x_jat_timestamp' ),
				$request->get_header( 'x_jat_nonce' ),
				(string) $request->get_body(),
				$request->get_header( 'x_jat_signature' ),
				time(),
				array( __CLASS__, 'nonce_seen' )
			);
			if ( true !== $result ) {
				return new WP_Error( $result, 'Request signature check failed.', array( 'status' => 401 ) );
			}
			if ( 'edit_post' === $capability ) {
				$id = self::url_id( $request );
				if ( ! get_post( $id ) ) {
					return new WP_Error( 'jat_not_found', 'Post not found.', array( 'status' => 404 ) );
				}
				return current_user_can( 'edit_post', $id ) ? true : new WP_Error( 'jat_forbidden', 'Not allowed to edit this post.', array( 'status' => 403 ) );
			}
			return current_user_can( $capability ) ? true : new WP_Error( 'jat_forbidden', 'The JAT Connector user lacks the required capability.', array( 'status' => 403 ) );
		};
	}

	/**
	 * Only the signed parts of a request are trusted: the JSON body and the route itself.
	 * $request['x'] would also read the (unsigned) query string, which takes precedence
	 * over URL parameters in WordPress's parameter order.
	 */
	private static function body( WP_REST_Request $r ) {
		$json = $r->get_json_params();
		return is_array( $json ) ? $json : array();
	}

	private static function url_id( WP_REST_Request $r ) {
		$url = $r->get_url_params();
		return isset( $url['id'] ) ? (int) $url['id'] : 0;
	}

	/** Records the nonce for 10 minutes; returns true if it was already used. */
	public static function nonce_seen( $nonce ) {
		$key = 'jat_nonce_' . md5( $nonce );
		if ( get_transient( $key ) ) {
			return true;
		}
		set_transient( $key, 1, 10 * MINUTE_IN_SECONDS );
		return false;
	}

	public static function health() {
		$user = wp_get_current_user();
		return array(
			'ok'                => true,
			'plugin_version'    => JAT_CONNECTOR_VERSION,
			'wordpress_version' => get_bloginfo( 'version' ),
			'seo_plugin'        => JAT_Seo::detect(),
			'user'              => $user->user_login,
			'can_publish'       => current_user_can( 'publish_posts' ),
		);
	}

	public static function create_post( WP_REST_Request $r ) {
		$b = self::body( $r );
		foreach ( array( 'title', 'content', 'excerpt', 'status', 'date_gmt' ) as $k ) {
			if ( isset( $b[ $k ] ) && ! is_string( $b[ $k ] ) ) {
				return new WP_Error( 'jat_bad_field', "$k must be a string.", array( 'status' => 400 ) );
			}
		}
		$status = isset( $b['status'] ) ? $b['status'] : '';
		if ( ! in_array( $status, array( 'draft', 'future' ), true ) ) {
			return new WP_Error( 'jat_bad_status', 'status must be draft or future.', array( 'status' => 400 ) );
		}
		if ( 'future' === $status && ! current_user_can( 'publish_posts' ) ) {
			return new WP_Error( 'jat_forbidden', 'Scheduling requires the publish_posts capability.', array( 'status' => 403 ) );
		}
		$postarr = array(
			'post_title'   => sanitize_text_field( isset( $b['title'] ) ? $b['title'] : '' ),
			'post_content' => wp_kses_post( isset( $b['content'] ) ? $b['content'] : '' ),
			'post_excerpt' => sanitize_textarea_field( isset( $b['excerpt'] ) ? $b['excerpt'] : '' ),
			'post_status'  => $status,
			'post_author'  => get_current_user_id(),
			'post_type'    => 'post',
		);
		if ( 'future' === $status ) {
			$ts = strtotime( isset( $b['date_gmt'] ) ? $b['date_gmt'] : '' );
			if ( ! $ts || $ts <= time() ) {
				return new WP_Error( 'jat_bad_date', 'date_gmt must be a future time.', array( 'status' => 400 ) );
			}
			$postarr['post_date_gmt'] = gmdate( 'Y-m-d H:i:s', $ts );
			$postarr['post_date']     = get_date_from_gmt( $postarr['post_date_gmt'] );
		}
		$id = wp_insert_post( $postarr, true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		return array(
			'id'        => $id,
			'status'    => get_post_status( $id ),
			'link'      => get_permalink( $id ),
			'edit_link' => get_edit_post_link( $id, 'raw' ),
		);
	}

	public static function get_seo( WP_REST_Request $r ) {
		$id = self::url_id( $r );
		return array( 'post_id' => $id, 'plugin' => JAT_Seo::detect(), 'fields' => JAT_Seo::get( $id ) );
	}

	public static function update_seo( WP_REST_Request $r ) {
		$id        = self::url_id( $r );
		$b         = self::body( $r );
		$change_id = isset( $b['change_id'] ) && is_string( $b['change_id'] ) ? $b['change_id'] : '';
		if ( ! preg_match( '/^[A-Za-z0-9_-]{8,64}$/', $change_id ) ) {
			return new WP_Error( 'jat_bad_change_id', 'change_id is required.', array( 'status' => 400 ) );
		}
		$fields = isset( $b['fields'] ) && is_array( $b['fields'] ) ? $b['fields'] : array();
		foreach ( $fields as $k => $v ) {
			// A non-string would sanitize to '' and silently delete the existing SEO value.
			if ( ! is_string( $v ) ) {
				return new WP_Error( 'jat_bad_field', "fields.$k must be a string.", array( 'status' => 400 ) );
			}
		}
		return JAT_Seo::update( $id, $change_id, $fields );
	}

	public static function rollback( WP_REST_Request $r ) {
		$url = $r->get_url_params();
		return JAT_Seo::rollback( isset( $url['change_id'] ) ? (string) $url['change_id'] : '' );
	}
}
